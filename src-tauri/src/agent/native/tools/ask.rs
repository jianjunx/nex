//! `ask_user_question` — structured multi-choice prompts for the Nex Agent.
//!
//! Mirrors Claude Code's AskUserQuestion: the model proposes 1–4 questions with
//! 2–4 options each; the host renders them via ACP `elicitation/create` (form
//! mode) and returns the user's selections as the tool result.

use agent_client_protocol as acp;

use super::{Tool, ToolCtx};

pub struct AskUserQuestion;

#[async_trait::async_trait(?Send)]
impl Tool for AskUserQuestion {
    fn name(&self) -> &'static str {
        "ask_user_question"
    }

    fn description(&self) -> &'static str {
        "Ask the user structured multiple-choice questions when you need a clear \
         decision (approach, library, trade-off, etc.). Prefer this over free-form \
         text questions. Provide 1–4 questions, each with 2–4 options. Do not include \
         an \"Other\" option — the UI always offers a free-text alternative. If you \
         have a recommendation, put it first and append \" (Recommended)\" to its label."
    }

    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "required": ["questions"],
            "properties": {
                "questions": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 4,
                    "description": "Questions to ask the user (1–4).",
                    "items": {
                        "type": "object",
                        "required": ["question", "header", "options", "multiSelect"],
                        "properties": {
                            "question": {
                                "type": "string",
                                "description": "Full question text, ending with '?'."
                            },
                            "header": {
                                "type": "string",
                                "description": "Short chip label (max ~12 chars)."
                            },
                            "multiSelect": {
                                "type": "boolean",
                                "description": "Allow selecting multiple options."
                            },
                            "options": {
                                "type": "array",
                                "minItems": 2,
                                "maxItems": 4,
                                "items": {
                                    "type": "object",
                                    "required": ["label", "description"],
                                    "properties": {
                                        "label": {
                                            "type": "string",
                                            "description": "Concise option label (1–5 words)."
                                        },
                                        "description": {
                                            "type": "string",
                                            "description": "What this option means / trade-offs."
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        })
    }

    fn kind(&self) -> acp::ToolKind {
        acp::ToolKind::Other
    }

    fn read_only(&self) -> bool {
        true
    }

    async fn execute(&self, args: serde_json::Value, ctx: &ToolCtx) -> Result<String, String> {
        let questions = extract_questions(&args)?;
        let Some(conn) = ctx.conn.as_ref() else {
            return Err("ask_user_question unavailable (no ACP connection)".into());
        };
        let session_id = ctx
            .session_id
            .as_deref()
            .ok_or_else(|| "ask_user_question unavailable (no session id)".to_string())?;

        let request = questions_to_elicitation_request(&questions, session_id, None);
        let response = conn
            .request_raw("elicitation/create", request)
            .await
            .map_err(|e| format!("elicitation failed: {e}"))?;

        Ok(format_answers(&questions, &response))
    }
}

#[derive(Debug, Clone)]
struct Question {
    question: String,
    header: String,
    multi_select: bool,
    options: Vec<OptionItem>,
}

#[derive(Debug, Clone)]
struct OptionItem {
    label: String,
    description: String,
}

fn extract_questions(args: &serde_json::Value) -> Result<Vec<Question>, String> {
    let arr = args
        .get("questions")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "missing required argument `questions`".to_string())?;
    if arr.is_empty() {
        return Err("`questions` must not be empty".into());
    }
    if arr.len() > 4 {
        return Err("`questions` supports at most 4 items".into());
    }
    let mut out = Vec::with_capacity(arr.len());
    for (i, q) in arr.iter().enumerate() {
        let question = q
            .get("question")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("questions[{i}]: missing `question`"))?
            .to_string();
        let header = q
            .get("header")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("Choice")
            .to_string();
        let multi_select = q
            .get("multiSelect")
            .or_else(|| q.get("multi_select"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let options_raw = q
            .get("options")
            .and_then(|v| v.as_array())
            .ok_or_else(|| format!("questions[{i}]: missing `options`"))?;
        if options_raw.len() < 2 || options_raw.len() > 4 {
            return Err(format!(
                "questions[{i}]: `options` must have 2–4 items (got {})",
                options_raw.len()
            ));
        }
        let mut options = Vec::with_capacity(options_raw.len());
        for (j, o) in options_raw.iter().enumerate() {
            let label = o
                .get("label")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("questions[{i}].options[{j}]: missing `label`"))?
                .to_string();
            let description = o
                .get("description")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .unwrap_or("")
                .to_string();
            options.push(OptionItem { label, description });
        }
        out.push(Question {
            question,
            header,
            multi_select,
            options,
        });
    }
    Ok(out)
}

/// Build an ACP form elicitation request matching Claude's AskUserQuestion shape.
fn questions_to_elicitation_request(
    questions: &[Question],
    session_id: &str,
    tool_call_id: Option<&str>,
) -> serde_json::Value {
    let single = questions.len() == 1;
    let mut properties = serde_json::Map::new();
    for (index, question) in questions.iter().enumerate() {
        let field = format!("question_{index}");
        let options: Vec<serde_json::Value> = question
            .options
            .iter()
            .map(|o| {
                let mut opt = serde_json::json!({
                    "const": o.label,
                    "title": o.label,
                });
                if !o.description.is_empty() {
                    opt["description"] = serde_json::Value::String(o.description.clone());
                }
                opt
            })
            .collect();
        let title = if question.header.is_empty() {
            None
        } else {
            Some(question.header.clone())
        };
        let description = if single {
            None
        } else {
            Some(question.question.clone())
        };
        let prop = if question.multi_select {
            serde_json::json!({
                "type": "array",
                "title": title,
                "description": description,
                "items": { "anyOf": options },
            })
        } else {
            serde_json::json!({
                "type": "string",
                "title": title,
                "description": description,
                "oneOf": options,
            })
        };
        properties.insert(field.clone(), prop);
        properties.insert(
            format!("{field}_custom"),
            serde_json::json!({
                "type": "string",
                "title": "Other",
                "description": "Type your own answer instead of choosing an option above (optional).",
                "_meta": {
                    "_askUserQuestionCustomAnswer": {
                        "questionId": field,
                        "isCustomAnswer": true,
                    }
                }
            }),
        );
    }
    let message = if single {
        questions[0].question.clone()
    } else {
        "Please answer the following questions.".to_string()
    };
    let mut req = serde_json::json!({
        "mode": "form",
        "sessionId": session_id,
        "message": message,
        "requestedSchema": {
            "type": "object",
            "properties": properties,
        },
    });
    if let Some(id) = tool_call_id {
        req["toolCallId"] = serde_json::Value::String(id.to_string());
    }
    req
}

fn format_answers(questions: &[Question], response: &serde_json::Value) -> String {
    let action = response.get("action").and_then(|v| v.as_str()).unwrap_or("");
    match action {
        "decline" => "User skipped the questions.".to_string(),
        "cancel" => "User cancelled the questions.".to_string(),
        "accept" => {
            let content = response
                .get("content")
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            let mut answers = serde_json::Map::new();
            for (index, question) in questions.iter().enumerate() {
                let field = format!("question_{index}");
                let custom = content
                    .get(&format!("{field}_custom"))
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                if let Some(text) = custom {
                    answers.insert(
                        question.question.clone(),
                        serde_json::Value::String(text.to_string()),
                    );
                    continue;
                }
                if let Some(value) = content.get(&field) {
                    let text = if let Some(arr) = value.as_array() {
                        arr.iter()
                            .filter_map(|v| v.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    } else {
                        value.as_str().unwrap_or("").to_string()
                    };
                    if !text.is_empty() {
                        answers.insert(question.question.clone(), serde_json::Value::String(text));
                    }
                }
            }
            if answers.is_empty() {
                "User skipped the questions.".to_string()
            } else {
                serde_json::json!({ "answers": answers }).to_string()
            }
        }
        _ => format!("Unexpected elicitation response: {response}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_questions_requires_options() {
        let args = serde_json::json!({
            "questions": [{
                "question": "Pick one?",
                "header": "Pick",
                "multiSelect": false,
                "options": [{ "label": "A", "description": "a" }]
            }]
        });
        assert!(extract_questions(&args).is_err());
    }

    #[test]
    fn elicitation_request_shape() {
        let qs = vec![Question {
            question: "Which approach?".into(),
            header: "Approach".into(),
            multi_select: false,
            options: vec![
                OptionItem {
                    label: "Fast".into(),
                    description: "Ship quickly".into(),
                },
                OptionItem {
                    label: "Careful".into(),
                    description: "More review".into(),
                },
            ],
        }];
        let req = questions_to_elicitation_request(&qs, "sess-1", Some("call-1"));
        assert_eq!(req["mode"], "form");
        assert_eq!(req["sessionId"], "sess-1");
        assert_eq!(req["toolCallId"], "call-1");
        assert_eq!(req["message"], "Which approach?");
        assert!(req["requestedSchema"]["properties"]["question_0"].is_object());
        assert!(req["requestedSchema"]["properties"]["question_0_custom"].is_object());
    }

    #[test]
    fn format_accept_answers() {
        let qs = vec![Question {
            question: "Which approach?".into(),
            header: "Approach".into(),
            multi_select: false,
            options: vec![],
        }];
        let response = serde_json::json!({
            "action": "accept",
            "content": { "question_0": "Fast" }
        });
        let out = format_answers(&qs, &response);
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["answers"]["Which approach?"], "Fast");
    }
}
