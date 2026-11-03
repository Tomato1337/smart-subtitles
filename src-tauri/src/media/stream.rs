use super::probe::Probe;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoMode { Copy, Vaapi, X264 }

pub fn video_mode(p: &Probe, vaapi_ok: bool) -> VideoMode {
    let v = &p.video;
    if v.codec == "h264" && (v.pix_fmt == "yuv420p" || v.pix_fmt == "yuvj420p") {
        VideoMode::Copy
    } else if vaapi_ok {
        VideoMode::Vaapi
    } else {
        VideoMode::X264
    }
}

pub fn stream_args(url: &str, start: f64, audio_index: u32, p: &Probe, mode: VideoMode, vaapi_dev: &str) -> Vec<String> {
    let mut a: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "error".into()];
    let w = p.video.width.min(1920);
    if mode == VideoMode::Vaapi {
        a.extend(["-hwaccel", "vaapi", "-hwaccel_device", vaapi_dev, "-hwaccel_output_format", "vaapi"].map(String::from));
    }
    a.extend(["-copyts".into(), "-ss".into(), start.to_string(), "-i".into(), url.into()]);
    a.extend(["-map".into(), format!("0:{}", p.video.index), "-map".into(), format!("0:{audio_index}")]);
    a.extend(["-c:a", "aac", "-b:a", "192k", "-ac", "2", "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1"].map(String::from));
    match mode {
        VideoMode::Copy => a.extend(["-c:v", "copy"].map(String::from)),
        VideoMode::Vaapi => {
            let tm = if p.video.hdr { "tonemap_vaapi=format=nv12:t=bt709:m=bt709:p=bt709," } else { "" };
            a.extend([
                "-vf".into(),
                format!("{tm}scale_vaapi=w={w}:h=-2:format=nv12"),
                "-c:v".into(), "h264_vaapi".into(),
                "-b:v".into(), "8M".into(), "-maxrate".into(), "10M".into(), "-bufsize".into(), "16M".into(),
                "-g".into(), "48".into(),
            ]);
        }
        VideoMode::X264 => a.extend([
            "-vf".into(),
            format!("scale={w}:-2,format=yuv420p"),
            "-c:v".into(), "libx264".into(), "-preset".into(), "veryfast".into(),
            "-crf".into(), "21".into(), "-g".into(), "48".into(),
        ]),
    }
    a.extend(["-avoid_negative_ts", "disabled", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof+frag_discont", "pipe:1"].map(String::from));
    a
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::probe::VideoInfo;

    fn probe(codec: &str, pix: &str, w: u32, hdr: bool) -> Probe {
        Probe {
            duration: 100.0,
            video: VideoInfo { index: 0, codec: codec.into(), pix_fmt: pix.into(), width: w, hdr },
            audio: vec![],
        }
    }
    const TAIL: &str = "-c:a aac -b:a 192k -ac 2 -sn -dn -map_metadata -1 -map_chapters -1";
    const OUT: &str = "-avoid_negative_ts disabled -f mp4 -movflags frag_keyframe+empty_moov+default_base_moof+frag_discont pipe:1";

    #[test]
    fn mode_selection() {
        assert_eq!(video_mode(&probe("h264", "yuv420p", 1920, false), true), VideoMode::Copy);
        assert_eq!(video_mode(&probe("hevc", "yuv420p10le", 3840, true), true), VideoMode::Vaapi);
        assert_eq!(video_mode(&probe("hevc", "yuv420p10le", 3840, true), false), VideoMode::X264);
        assert_eq!(video_mode(&probe("h264", "yuv420p10le", 1920, false), true), VideoMode::Vaapi);
    }

    #[test]
    fn copy_args() {
        let p = probe("h264", "yuv420p", 1920, false);
        let s = stream_args("U", 898.898, 2, &p, VideoMode::Copy, "/dev/dri/renderD128").join(" ");
        assert_eq!(s, format!("-hide_banner -loglevel error -copyts -ss 898.898 -i U -map 0:0 -map 0:2 {TAIL} -c:v copy {OUT}"));
    }

    #[test]
    fn vaapi_hdr_args() {
        let p = probe("hevc", "yuv420p10le", 3840, true);
        let s = stream_args("U", 0.0, 1, &p, VideoMode::Vaapi, "/dev/dri/renderD128").join(" ");
        assert_eq!(s, format!(
            "-hide_banner -loglevel error -hwaccel vaapi -hwaccel_device /dev/dri/renderD128 -hwaccel_output_format vaapi -copyts -ss 0 -i U -map 0:0 -map 0:1 {TAIL} -vf tonemap_vaapi=format=nv12:t=bt709:m=bt709:p=bt709,scale_vaapi=w=1920:h=-2:format=nv12 -c:v h264_vaapi -b:v 8M -maxrate 10M -bufsize 16M -g 48 {OUT}"));
    }

    #[test]
    fn x264_args_sdr_small() {
        let p = probe("mpeg4", "yuv420p", 1280, false);
        let s = stream_args("U", 5.0, 1, &p, VideoMode::X264, "d").join(" ");
        assert_eq!(s, format!("-hide_banner -loglevel error -copyts -ss 5 -i U -map 0:0 -map 0:1 {TAIL} -vf scale=1280:-2,format=yuv420p -c:v libx264 -preset veryfast -crf 21 -g 48 {OUT}"));
    }
}
