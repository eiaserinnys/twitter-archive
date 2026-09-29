export interface JevNoulQuestion { type: "noul"; instructions: string; criteria: { true: string; false: string } }
export interface JevChoiceQuestion { type: "choice"; instructions: string; criteria: Record<string, string> }
export type JevQuestion = JevNoulQuestion | JevChoiceQuestion;
export interface JevRequest { state: string; questions: Record<string, JevQuestion> }
export interface JevAnswer { noul?: number; choice?: string; probabilities?: Record<string, number> }
export interface JevResult { answers: Record<string, JevAnswer>; inputTokens: number }
export interface JevConfig { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch }
export const JEV_USD_PER_MILLION_INPUT = 0.042;

export async function callJev(config: JevConfig, request: JevRequest): Promise<JevResult> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(`${config.baseUrl.replace(/\/$/, "")}/v1/systemone`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ state: request.state, model: "jev-latest", questions: request.questions }),
  });
  if (!response.ok) throw new Error(`Jev HTTP ${response.status}`);
  const body = (await response.json()) as { answers?: Record<string, JevAnswer>; usage?: { input_tokens?: number } };
  if (!body.answers || typeof body.usage?.input_tokens !== "number") throw new Error("Jev response has no answers or usage.");
  return { answers: body.answers, inputTokens: body.usage.input_tokens };
}
