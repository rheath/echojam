import "server-only";

import {
  buildInstagramScriptGenerationSourceText,
  toNullableTrimmed,
  type InstagramScriptGenerationSources,
} from "@/lib/instagramImport";
import type { PlaceGrounding } from "@/lib/placeGrounding";

type GroundedSocialScript = {
  title: string;
  script: string;
};

function extractJsonObject(raw: string) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) return trimmed.slice(firstBrace, lastBrace + 1);
  throw new Error("JSON response was not found in model output");
}

export async function generateGroundedSocialScriptWithOpenAI(
  apiKey: string,
  sourceLabel: "Instagram" | "TikTok",
  sources: InstagramScriptGenerationSources,
  currentTitle: string | null | undefined,
  placeGrounding: PlaceGrounding
): Promise<GroundedSocialScript> {
  const promptSourceText = buildInstagramScriptGenerationSourceText(sources);
  if (!promptSourceText) {
    throw new Error(`${sourceLabel} script generation sources were empty`);
  }

  const normalizedCurrentTitle = toNullableTrimmed(currentTitle);

  const systemPrompt = [
    `You rewrite one ${sourceLabel} travel draft into a single grounded EchoJam stop.`,
    "The confirmed place context is authoritative for where the stop is located.",
    "Use the imported source text for narrative substance, sensory detail, and story beats.",
    "If the source text conflicts with the confirmed place context, prefer the confirmed place context and avoid repeating the conflicting location claim.",
    "Return strict JSON only with keys: title, script.",
  ].join(" ");

  const userPrompt = [
    `Confirmed place: ${placeGrounding.resolvedName || "Unknown place"}`,
    ...(placeGrounding.venueCategory ? [`Venue type: ${placeGrounding.venueCategory}`] : []),
    ...(placeGrounding.neighborhood ? [`Neighborhood or borough: ${placeGrounding.neighborhood}`] : []),
    ...(placeGrounding.city ? [`City: ${placeGrounding.city}`] : []),
    ...(placeGrounding.region ? [`Region: ${placeGrounding.region}`] : []),
    ...(placeGrounding.country ? [`Country: ${placeGrounding.country}`] : []),
    ...(placeGrounding.localContext ? [`Local context: ${placeGrounding.localContext}`] : []),
    ...(normalizedCurrentTitle ? [`Current draft title: ${normalizedCurrentTitle}`] : []),
    "Write one grounded stop only.",
    "title: concise user-facing stop title aligned to the confirmed place.",
    "script: 90-180 words of polished spoken tour narration.",
    "Let the confirmed place context influence neighborhood, city, venue type, and sense of place.",
    "Do not mention latitude, longitude, raw coordinates, or map-like phrasing.",
    "Do not mechanically recite the full street address unless the source material naturally depends on it.",
    "",
    promptSourceText,
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.45,
      max_tokens: 420,
    }),
  });

  if (!response.ok) {
    throw new Error("OpenAI grounded social script generation failed");
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = toNullableTrimmed(payload.choices?.[0]?.message?.content || "");
  if (!raw) throw new Error("Grounded social script generation returned empty output");

  const parsed = JSON.parse(extractJsonObject(raw)) as Partial<GroundedSocialScript>;
  const title = toNullableTrimmed(parsed.title) || normalizedCurrentTitle || placeGrounding.resolvedName || "Imported stop";
  const script = toNullableTrimmed(parsed.script);
  if (!script) throw new Error("Grounded social script generation returned an empty script");

  return {
    title,
    script,
  };
}
