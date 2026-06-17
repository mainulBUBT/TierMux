// Mirror of agent.splitReasoning, isolated so the self-test avoids importing
// agent.ts (which pulls in the vscode module).
export function splitReasoningStandalone(text: string): { reasoning?: string; content: string } {
  const m = /^\s*<think>([\s\S]*?)<\/think>\s*/i.exec(text);
  if (m) return { reasoning: m[1].trim(), content: text.slice(m[0].length).trim() };
  return { content: text };
}
