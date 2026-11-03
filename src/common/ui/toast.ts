import { create } from 'zustand'

export type ToastOptions = { durationMs?: number; action?: { label: string; run: () => void } }

type ToastState = {
  message: string | null
  options: ToastOptions
  seq: number
  show: (message: string, options?: ToastOptions) => void
  hide: () => void
}

export const useToast = create<ToastState>((set) => ({
  message: null,
  options: {},
  seq: 0,
  show: (message, options = {}) => set((s) => ({ message, options, seq: s.seq + 1 })),
  hide: () => set({ message: null }),
}))

export const toast = (message: string, options?: ToastOptions) => useToast.getState().show(message, options)
