//! Per-task LLM routing: every call names its task, and the task picks provider, model and effort.

use crate::llm::providers::Endpoint;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Task {
    Annotate,
    Explain,
    Draft,
    Chat,
    Cost,
}

impl Task {
    pub const ALL: [Task; 5] = [Task::Annotate, Task::Explain, Task::Draft, Task::Chat, Task::Cost];

    /// Key in config.json (`llmTasks.<key>`) and in the `llm_usage` table.
    pub fn key(self) -> &'static str {
        match self {
            Task::Annotate => "annotate",
            Task::Explain => "explain",
            Task::Draft => "draft",
            Task::Chat => "chat",
            Task::Cost => "cost",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    #[default]
    Off,
    Low,
    Medium,
    High,
}

impl Effort {
    /// Extra output room for reasoning; also the Anthropic budget_tokens fallback.
    pub fn extra_tokens(self) -> u32 {
        match self {
            Effort::Off => 0,
            Effort::Low => 2048,
            Effort::Medium => 8192,
            Effort::High => 16384,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Effort::Off => "off",
            Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
        }
    }
}

/// Everything one LLM call needs, resolved from the live config.
#[derive(Debug, Clone)]
pub struct Target {
    pub task: Task,
    pub source: String,
    pub provider: String,
    pub model: String,
    pub effort: Effort,
    pub endpoint: Endpoint,
}
