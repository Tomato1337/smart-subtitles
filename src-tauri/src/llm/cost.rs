use super::{
    catalog,
    client,
    tasks::Task,
    usage::Usage,
};
use crate::{state::AppState, types::AnnotEstimate};
use serde::{Deserialize, Serialize};
use serde_json::json;

/// Price of the remaining analysis: from the price catalog, or the cost model's guess.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct AnnotCost {
    pub usd: Option<f64>,
    pub input_price: Option<f64>,
    pub cached_price: Option<f64>,
    pub output_price: Option<f64>,
    pub note: String,
    /// "catalog" when computed from the local price table, "llm" when the cost model guessed.
    pub source: String,
    pub model: String,
}

/// The catalog price of `model` for this volume, or `None` when the catalog has no price for it.
fn from_catalog(info: &catalog::ModelInfo, model: &str, e: &AnnotEstimate) -> Option<AnnotCost> {
    let p = info.price?;
    let u = Usage {
        input: e.input_tokens.saturating_sub(e.cached_tokens),
        cache_read: e.cached_tokens,
        cache_write: 0,
        output: e.output_tokens,
    };
    Some(AnnotCost {
        usd: Some(catalog::cost_usd(&p, &u)),
        input_price: Some(p.input),
        cached_price: Some(p.cache_read.unwrap_or(p.input)),
        output_price: Some(p.output),
        note: format!("Цены из {}", info.price_source),
        source: "catalog".into(),
        model: model.to_string(),
    })
}

/// The catalog price of the annotate model when it is known; the LLM is asked only otherwise.
pub async fn estimate_cost(st: &AppState, media_id: &str, e: &AnnotEstimate) -> Result<AnnotCost, String> {
    let t = st.cfg().target(Task::Annotate);
    let info = catalog::model_info_for(st, &t).await;
    if let Some(c) = from_catalog(&info, &t.model, e) {
        return Ok(c);
    }
    let text = format!(
        "Оцени стоимость API-запросов в долларах США. Провайдер: {}. Base URL: {}. Модель: {}.\n\
         Объём: входных токенов {}, из них {} могут быть прочитаны из кэша префикса провайдера (если он его поддерживает); выходных токенов {}.\n\
         Используй известные тебе цены этого провайдера на эту модель за 1M токенов. Если точной цены не знаешь — оцени по похожей модели и скажи об этом в note.\n\
         Верни строго JSON: {{\"usd\": <итог или null>, \"inputPrice\": <$ за 1M входных без кэша или null>, \"cachedPrice\": <$ за 1M из кэша или null>, \"outputPrice\": <$ за 1M выходных или null>, \"note\": \"<1–2 предложения по-русски: откуда цены и насколько оценка надёжна>\"}}",
        t.provider, t.endpoint.base_url, t.model, e.input_tokens, e.cached_tokens, e.output_tokens
    );
    let messages = vec![json!({ "role": "user", "content": text })];
    let mut c = client::chat_json::<AnnotCost>(st, Task::Cost, media_id, "cost", &messages, 800).await.map_err(|e| format!("{e:#}"))?;
    c.source = "llm".into();
    c.model = st.cfg().target(Task::Cost).model;
    Ok(c)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::catalog::{ModelInfo, Price};

    fn estimate() -> AnnotEstimate {
        AnnotEstimate { cues: 1400, batches: 35, input_tokens: 1_450_000, cached_tokens: 1_300_000, output_tokens: 100_000, partial: false }
    }

    #[test]
    fn catalog_price_needs_no_llm_call() {
        let info = ModelInfo {
            name: "DeepSeek".into(),
            context_window: Some(1_048_576),
            price: Some(Price { input: 0.15, output: 0.6, cache_read: Some(0.003), cache_write: None }),
            price_source: "models.dev · deepseek/deepseek-flash".into(),
        };
        let c = from_catalog(&info, "deepseek-flash", &estimate()).unwrap();
        assert_eq!(c.source, "catalog");
        assert_eq!(c.model, "deepseek-flash");
        assert!((c.usd.unwrap() - 0.0864).abs() < 1e-9);
        assert_eq!(c.input_price, Some(0.15));
        assert_eq!(c.cached_price, Some(0.003));
        assert_eq!(c.output_price, Some(0.6));
        assert_eq!(c.note, "Цены из models.dev · deepseek/deepseek-flash");
    }

    #[test]
    fn without_a_price_the_model_is_asked() {
        let info = ModelInfo { name: "m".into(), ..Default::default() };
        assert!(from_catalog(&info, "m", &estimate()).is_none());
    }
}
