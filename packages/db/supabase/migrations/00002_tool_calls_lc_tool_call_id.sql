-- Idempotent HITL: match LangGraph AIMessage tool_call id to tool_calls row per session
alter table public.tool_calls
  add column if not exists lc_tool_call_id text;

create unique index if not exists tool_calls_session_lc_tool_call_id_key
  on public.tool_calls (session_id, lc_tool_call_id)
  where lc_tool_call_id is not null;
