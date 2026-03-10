import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildGooglePlaceIdPhotoUrl,
  cityPlaceholderImage,
  isValidGooglePlaceId,
  proxyGoogleImageUrl,
} from "@/lib/placesImages";
import {
  composeInstagramImportSourceText,
  estimateTextTokenCount,
  type InstagramDraftContent,
  type InstagramImportDraftStatus,
  type InstagramImportJobPhase,
  nextInstagramDraftStatus,
  parseInstagramPublicMetadataFromHtml,
  resolveInstagramDraftScript,
  resolveInstagramDraftTitle,
  successJobStatusForPhase,
  toNullableTrimmed,
  type InstagramPlaceCandidate,
} from "@/lib/instagramImport";
import { ensureCanonicalStopForCustom, upsertRouteStopMapping } from "@/lib/canonicalStops";
import {
  synthesizeSpeechWithOpenAI,
  toNullableAudioUrl,
  uploadNarrationAudio,
} from "@/lib/mixGeneration";
import { getSupabaseAdminClient } from "@/lib/server/supabaseAdmin";

type InstagramImportDraftRow = {
  id: string;
  source_url: string;
  source_kind: "reel" | "post";
  source_shortcode: string;
  source_owner_title: string | null;
  source_owner_user_id: string | null;
  source_caption: string | null;
  source_thumbnail_url: string | null;
  transcript_raw: string | null;
  transcript_cleaned: string | null;
  generated_title: string | null;
  generated_script: string | null;
  edited_title: string | null;
  edited_script: string | null;
  place_query: string | null;
  place_city_hint: string | null;
  place_country_hint: string | null;
  place_confidence: number | null;
  suggested_place_label: string | null;
  suggested_place_lat: number | null;
  suggested_place_lng: number | null;
  suggested_place_image_url: string | null;
  suggested_google_place_id: string | null;
  confirmed_place_label: string | null;
  confirmed_place_lat: number | null;
  confirmed_place_lng: number | null;
  confirmed_place_image_url: string | null;
  confirmed_google_place_id: string | null;
  status: InstagramImportDraftStatus;
  warning: string | null;
  error: string | null;
  published_jam_id: string | null;
  published_route_id: string | null;
  created_at: string;
  updated_at: string;
};

type InstagramImportJobRow = {
  id: string;
  draft_id: string;
  phase: InstagramImportJobPhase;
  status: "queued" | "processing" | "draft_ready" | "published" | "failed";
  progress: number;
  message: string;
  error: string | null;
  attempts: number;
  locked_at: string | null;
  last_heartbeat_at: string | null;
  lock_token: string | null;
  created_at: string;
  updated_at: string;
};

type TourStopConversion = {
  title: string;
  script: string;
  placeQuery: string;
  cityHint: string | null;
  countryHint: string | null;
  confidence: number;
};

type GooglePlaceSearchResponse = {
  places?: Array<{
    id?: string;
    name?: string;
    displayName?: { text?: string };
    location?: { latitude?: number; longitude?: number };
    formattedAddress?: string;
  }>;
  error?: {
    message?: string;
  };
};

const DRAFT_SELECT = `
  id,
  source_url,
  source_kind,
  source_shortcode,
  source_owner_title,
  source_owner_user_id,
  source_caption,
  source_thumbnail_url,
  transcript_raw,
  transcript_cleaned,
  generated_title,
  generated_script,
  edited_title,
  edited_script,
  place_query,
  place_city_hint,
  place_country_hint,
  place_confidence,
  suggested_place_label,
  suggested_place_lat,
  suggested_place_lng,
  suggested_place_image_url,
  suggested_google_place_id,
  confirmed_place_label,
  confirmed_place_lat,
  confirmed_place_lng,
  confirmed_place_image_url,
  confirmed_google_place_id,
  status,
  warning,
  error,
  published_jam_id,
  published_route_id,
  created_at,
  updated_at
`;

const JOB_SELECT = `
  id,
  draft_id,
  phase,
  status,
  progress,
  message,
  error,
  attempts,
  locked_at,
  last_heartbeat_at,
  lock_token,
  created_at,
  updated_at
`;

const GOOGLE_TEXT_SEARCH_NEW_ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const INSTAGRAM_FETCH_TIMEOUT_MS = 12_000;
const YT_DLP_TIMEOUT_MS = 90_000;
const FFMPEG_TIMEOUT_MS = 45_000;
const JOB_STALE_MS = 10 * 60 * 1000;
const DEFAULT_WORKER_LIMIT = 2;
const INSTAGRAM_FETCH_USER_AGENTS = [
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "Twitterbot/1.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
];

function getOpenAiApiKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required.");
  return apiKey;
}

function estimateRouteLengthMinutes(script: string) {
  const words = script.split(/\s+/).filter(Boolean).length;
  return Math.max(5, Math.min(30, Math.round(words / 120) || 5));
}

function buildDraftContent(row: InstagramImportDraftRow): InstagramDraftContent {
  return {
    editedTitle: row.edited_title,
    editedScript: row.edited_script,
    generatedTitle: row.generated_title,
    generatedScript: row.generated_script,
    confirmedPlaceLabel: row.confirmed_place_label,
    confirmedPlaceLat: row.confirmed_place_lat,
    confirmedPlaceLng: row.confirmed_place_lng,
  };
}

function makePlaceCandidate(
  label: string | null,
  lat: number | null,
  lng: number | null,
  imageUrl: string | null,
  googlePlaceId: string | null,
  formattedAddress: string | null = null
): InstagramPlaceCandidate | null {
  if (!label || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const safeLat = Number(lat);
  const safeLng = Number(lng);
  return {
    label,
    lat: safeLat,
    lng: safeLng,
    imageUrl: proxyGoogleImageUrl(imageUrl) || imageUrl,
    googlePlaceId,
    formattedAddress,
  };
}

export function serializeInstagramJob(job: InstagramImportJobRow | null) {
  if (!job) return null;
  return {
    id: job.id,
    draftId: job.draft_id,
    phase: job.phase,
    status: job.status,
    progress: job.progress,
    message: job.message,
    error: job.error,
    attempts: job.attempts,
    updatedAt: job.updated_at,
  };
}

export function serializeInstagramDraft(
  row: InstagramImportDraftRow,
  latestJob: InstagramImportJobRow | null
) {
  const finalScript = resolveInstagramDraftScript(buildDraftContent(row));
  const extractedText = composeInstagramImportSourceText(row.source_caption, row.transcript_raw);

  return {
    id: row.id,
    status: row.status,
    warning: row.warning,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    source: {
      url: row.source_url,
      kind: row.source_kind,
      shortcode: row.source_shortcode,
      ownerTitle: row.source_owner_title,
      ownerUserId: row.source_owner_user_id,
      caption: row.source_caption,
      thumbnailUrl: proxyGoogleImageUrl(row.source_thumbnail_url) || row.source_thumbnail_url,
    },
    content: {
      generatedTitle: row.generated_title,
      generatedScript: row.generated_script,
      editedTitle: row.edited_title,
      editedScript: row.edited_script,
      finalTitle: resolveInstagramDraftTitle(buildDraftContent(row)),
      finalScript: resolveInstagramDraftScript(buildDraftContent(row)),
    },
    location: {
      placeQuery: row.place_query,
      cityHint: row.place_city_hint,
      countryHint: row.place_country_hint,
      confidence: row.place_confidence,
      suggestedPlace: makePlaceCandidate(
        row.suggested_place_label,
        row.suggested_place_lat,
        row.suggested_place_lng,
        row.suggested_place_image_url,
        row.suggested_google_place_id
      ),
      confirmedPlace: makePlaceCandidate(
        row.confirmed_place_label,
        row.confirmed_place_lat,
        row.confirmed_place_lng,
        row.confirmed_place_image_url,
        row.confirmed_google_place_id
      ),
      publishReady: Boolean(
        resolveInstagramDraftTitle(buildDraftContent(row)) &&
          resolveInstagramDraftScript(buildDraftContent(row)) &&
          row.confirmed_place_label &&
          Number.isFinite(row.confirmed_place_lat) &&
          Number.isFinite(row.confirmed_place_lng)
      ),
    },
    publish: {
      publishedJamId: row.published_jam_id,
      publishedRouteId: row.published_route_id,
    },
    metrics: {
      extractedTextTokensEstimate: estimateTextTokenCount(extractedText),
      cleanedTextTokensEstimate: estimateTextTokenCount(row.transcript_cleaned),
      finalScriptTokensEstimate: estimateTextTokenCount(finalScript),
    },
    latestJob: serializeInstagramJob(latestJob),
  };
}

async function execFileAsync(
  file: string,
  args: string[],
  timeoutMs: number
) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

async function fetchInstagramHtml(url: string) {
  let lastError: Error | null = null;

  for (const userAgent of INSTAGRAM_FETCH_USER_AGENTS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), INSTAGRAM_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": userAgent,
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
        cache: "no-store",
      });
      if (!response.ok) {
        lastError = new Error(`Instagram page request failed (${response.status})`);
        continue;
      }

      const html = await response.text();
      const metadata = parseInstagramPublicMetadataFromHtml(html);
      if (metadata.ownerTitle || metadata.caption || metadata.thumbnailUrl || metadata.ownerUserId) {
        return html;
      }

      lastError = new Error("Instagram HTML response did not include public metadata");
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Instagram page request failed");
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError || new Error("Instagram page request failed");
}

async function downloadInstagramMedia(url: string, outputDir: string) {
  const outputTemplate = path.join(outputDir, "%(id)s.%(ext)s");
  await execFileAsync(
    process.env.YT_DLP_PATH || "yt-dlp",
    [
      "--no-playlist",
      "--restrict-filenames",
      "--output",
      outputTemplate,
      "--format",
      "mp4/best",
      url,
    ],
    YT_DLP_TIMEOUT_MS
  );

  const entries = await fs.readdir(outputDir);
  const mediaFile = entries
    .map((entry) => path.join(outputDir, entry))
    .find((entry) => /\.(mp4|m4a|webm|mov)$/i.test(entry));
  if (!mediaFile) {
    throw new Error("yt-dlp did not produce a media file");
  }
  return mediaFile;
}

async function extractAudioTrack(inputPath: string, outputPath: string) {
  await execFileAsync(
    process.env.FFMPEG_PATH || "ffmpeg",
    [
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      "64k",
      outputPath,
    ],
    FFMPEG_TIMEOUT_MS
  );
}

async function transcribeAudioWithOpenAi(apiKey: string, audioPath: string) {
  const fileBytes = await fs.readFile(audioPath);
  const form = new FormData();
  form.append("model", process.env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1");
  form.append("response_format", "text");
  form.append("file", new Blob([fileBytes], { type: "audio/mpeg" }), path.basename(audioPath));

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Audio transcription failed (${response.status}${body ? `: ${body}` : ""})`);
  }
  return toNullableTrimmed(await response.text());
}

async function runChatCompletion(apiKey: string, systemPrompt: string, userPrompt: string) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 900,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI chat completion failed (${response.status}${body ? `: ${body}` : ""})`);
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return toNullableTrimmed(payload.choices?.[0]?.message?.content || "");
}

function extractJsonObject(raw: string) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  throw new Error("JSON response was not found in model output");
}

async function cleanupImportedText(apiKey: string, importedText: string) {
  const systemPrompt = [
    "You clean travel post source material into concise factual notes for a tour draft.",
    "Preserve place names, sensory details, logistics, and story facts.",
    "Remove hashtags, repeated calls to action, emoji spam, discount language, and creator self-promotion.",
    "Keep plain text only.",
  ].join(" ");
  const userPrompt = [
    "Clean this Instagram source material for tour drafting.",
    "If transcript and caption disagree, prefer factual place names and concrete details.",
    "Do not invent locations or details.",
    "",
    importedText,
  ].join("\n");
  return await runChatCompletion(apiKey, systemPrompt, userPrompt);
}

async function convertCleanedTextToTourStop(apiKey: string, cleanedText: string) {
  const systemPrompt = [
    "You convert travel source material into one EchoJam tour stop.",
    "If the source mentions multiple locations, pick one primary place only.",
    "Choose the place most central to the story, not a route summary.",
    "Return strict JSON only.",
  ].join(" ");

  const userPrompt = [
    "Convert this cleaned Instagram source into exactly one draft stop.",
    "Output JSON with keys: title, script, placeQuery, cityHint, countryHint, confidence.",
    "title: a short user-facing stop title.",
    "script: 90-180 words of spoken tour narration.",
    "placeQuery: the best single place search query for Google Places.",
    "cityHint: the most likely city or region if known, else null.",
    "countryHint: the most likely country if known, else null.",
    "confidence: number from 0 to 1.",
    "Use null for unknown hints.",
    "",
    cleanedText,
  ].join("\n");

  const raw = await runChatCompletion(apiKey, systemPrompt, userPrompt);
  if (!raw) {
    throw new Error("Tour stop conversion returned empty output");
  }

  const parsed = JSON.parse(extractJsonObject(raw)) as Partial<TourStopConversion>;
  const title = toNullableTrimmed(parsed.title);
  const script = toNullableTrimmed(parsed.script);
  const placeQuery = toNullableTrimmed(parsed.placeQuery);
  if (!title || !script || !placeQuery) {
    throw new Error("Tour stop conversion returned incomplete JSON");
  }
  const confidence = Number(parsed.confidence);
  return {
    title,
    script,
    placeQuery,
    cityHint: toNullableTrimmed(parsed.cityHint),
    countryHint: toNullableTrimmed(parsed.countryHint),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.45,
  } satisfies TourStopConversion;
}

function buildPlaceSearchQueries(query: string, cityHint: string | null, countryHint: string | null) {
  const candidates = [
    query,
    [query, cityHint].filter(Boolean).join(" "),
    [query, cityHint, countryHint].filter(Boolean).join(" "),
  ];
  return Array.from(new Set(candidates.map((value) => value.trim()).filter(Boolean)));
}

async function searchPlaces(query: string, cityHint: string | null, countryHint: string | null, limit = 5) {
  const apiKey = (process.env.GOOGLE_PLACES_API_KEY || "").trim();
  if (!apiKey) return [] as InstagramPlaceCandidate[];

  const queries = buildPlaceSearchQueries(query, cityHint, countryHint);
  const seen = new Set<string>();
  const results: InstagramPlaceCandidate[] = [];

  for (const textQuery of queries) {
    const response = await fetch(GOOGLE_TEXT_SEARCH_NEW_ENDPOINT, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask":
          "places.id,places.name,places.displayName,places.location,places.formattedAddress",
      },
      body: JSON.stringify({
        textQuery,
        maxResultCount: limit,
      }),
    });
    if (!response.ok) continue;
    const payload = (await response.json()) as GooglePlaceSearchResponse;
    if (!Array.isArray(payload.places)) continue;

    for (const place of payload.places) {
      const label = toNullableTrimmed(place.displayName?.text);
      const lat = Number(place.location?.latitude);
      const lng = Number(place.location?.longitude);
      const googlePlaceId = toNullableTrimmed(place.id || place.name?.replace(/^places\//, "") || null);
      if (!label || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const key = googlePlaceId || `${lat.toFixed(6)},${lng.toFixed(6)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        label,
        lat,
        lng,
        imageUrl: googlePlaceId && isValidGooglePlaceId(googlePlaceId) ? buildGooglePlaceIdPhotoUrl(googlePlaceId) : null,
        googlePlaceId: isValidGooglePlaceId(googlePlaceId) ? googlePlaceId : null,
        formattedAddress: toNullableTrimmed(place.formattedAddress),
      });
      if (results.length >= limit) return results;
    }
  }

  return results;
}

async function loadDraft(admin: SupabaseClient, draftId: string) {
  const { data, error } = await admin
    .from("instagram_import_drafts")
    .select(DRAFT_SELECT)
    .eq("id", draftId)
    .single();
  if (error || !data) throw new Error(error?.message || "Instagram draft not found");
  return data as InstagramImportDraftRow;
}

async function loadLatestJobForDraft(admin: SupabaseClient, draftId: string) {
  const { data, error } = await admin
    .from("instagram_import_jobs")
    .select(JOB_SELECT)
    .eq("draft_id", draftId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data ?? null) as InstagramImportJobRow | null;
}

export async function getInstagramDraftResponseById(
  draftId: string,
  admin: SupabaseClient = getSupabaseAdminClient()
) {
  const [draft, latestJob] = await Promise.all([
    loadDraft(admin, draftId),
    loadLatestJobForDraft(admin, draftId),
  ]);
  return serializeInstagramDraft(draft, latestJob);
}

export async function createInstagramImportJob(
  draftId: string,
  phase: InstagramImportJobPhase,
  admin: SupabaseClient = getSupabaseAdminClient()
) {
  const { data, error } = await admin
    .from("instagram_import_jobs")
    .insert({
      draft_id: draftId,
      phase,
      status: "queued",
      progress: 0,
      message: phase === "import" ? "Queued for import" : "Queued for publish",
      error: null,
    })
    .select(JOB_SELECT)
    .single();
  if (error || !data) throw new Error(error?.message || "Failed to create Instagram import job");
  return data as InstagramImportJobRow;
}

export async function searchInstagramImportPlaces(
  draftId: string,
  query: string | null | undefined,
  admin: SupabaseClient = getSupabaseAdminClient()
) {
  const draft = await loadDraft(admin, draftId);
  const searchQuery =
    toNullableTrimmed(query) ||
    toNullableTrimmed(draft.place_query) ||
    resolveInstagramDraftTitle(buildDraftContent(draft));
  if (!searchQuery) return [];
  return await searchPlaces(searchQuery, draft.place_city_hint, draft.place_country_hint);
}

async function updateJobWithLock(
  admin: SupabaseClient,
  jobId: string,
  lockToken: string,
  patch: Partial<InstagramImportJobRow>
) {
  const timestamp = new Date().toISOString();
  const { error } = await admin
    .from("instagram_import_jobs")
    .update({
      ...patch,
      locked_at: timestamp,
      last_heartbeat_at: timestamp,
    })
    .eq("id", jobId)
    .eq("lock_token", lockToken);
  if (error) throw new Error(error.message);
}

async function updateDraft(
  admin: SupabaseClient,
  draftId: string,
  patch: Partial<InstagramImportDraftRow>
) {
  const { error } = await admin
    .from("instagram_import_drafts")
    .update(patch)
    .eq("id", draftId);
  if (error) throw new Error(error.message);
}

async function claimNextJob(admin: SupabaseClient) {
  const { data: queued, error: queuedErr } = await admin
    .from("instagram_import_jobs")
    .select(JOB_SELECT)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (queuedErr) throw new Error(queuedErr.message);

  let candidate = (queued ?? null) as InstagramImportJobRow | null;
  if (!candidate) {
    const staleBefore = new Date(Date.now() - JOB_STALE_MS).toISOString();
    const { data: stale, error: staleErr } = await admin
      .from("instagram_import_jobs")
      .select(JOB_SELECT)
      .eq("status", "processing")
      .lt("locked_at", staleBefore)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (staleErr) throw new Error(staleErr.message);
    candidate = (stale ?? null) as InstagramImportJobRow | null;
  }
  if (!candidate) return null;

  const lockToken = randomUUID();
  const now = new Date().toISOString();
  const { data: claimed, error: claimErr } = await admin
    .from("instagram_import_jobs")
    .update({
      status: "processing",
      progress: Math.max(candidate.progress || 0, 5),
      message: candidate.phase === "import" ? "Importing Instagram post" : "Publishing draft",
      error: null,
      attempts: (candidate.attempts || 0) + 1,
      locked_at: now,
      last_heartbeat_at: now,
      lock_token: lockToken,
    })
    .eq("id", candidate.id)
    .eq("status", candidate.status)
    .select(JOB_SELECT)
    .maybeSingle();
  if (claimErr || !claimed) return null;
  return { job: claimed as InstagramImportJobRow, lockToken };
}

async function buildImportedTranscript(
  apiKey: string,
  normalizedUrl: string
) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "echojam-ig-"));
  let cleanupWarning: string | null = null;
  try {
    const mediaPath = await downloadInstagramMedia(normalizedUrl, tempDir);
    const audioPath = path.join(tempDir, `${createHash("sha1").update(mediaPath).digest("hex").slice(0, 12)}.mp3`);
    await extractAudioTrack(mediaPath, audioPath);
    const transcript = await transcribeAudioWithOpenAi(apiKey, audioPath);
    return { transcript, warning: cleanupWarning };
  } catch (error) {
    cleanupWarning = error instanceof Error ? error.message : "Media extraction failed";
    return { transcript: null, warning: cleanupWarning };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function processImportJob(
  admin: SupabaseClient,
  job: InstagramImportJobRow,
  lockToken: string
) {
  const draft = await loadDraft(admin, job.draft_id);
  const apiKey = getOpenAiApiKey();

  await updateDraft(admin, draft.id, {
    status: nextInstagramDraftStatus(draft.status, "import_started"),
    error: null,
  });

  await updateJobWithLock(admin, job.id, lockToken, {
    progress: 15,
    message: "Fetching Instagram metadata",
  });

  const html = await fetchInstagramHtml(draft.source_url);
  const metadata = parseInstagramPublicMetadataFromHtml(html);

  await updateJobWithLock(admin, job.id, lockToken, {
    progress: 35,
    message: "Extracting audio and transcript",
  });

  const transcriptResult = await buildImportedTranscript(apiKey, draft.source_url);
  const transcript = transcriptResult.transcript;
  const importedText = composeInstagramImportSourceText(metadata.caption, transcript);
  if (!importedText) {
    throw new Error("No transcript or caption text was available for this Instagram post");
  }

  await updateJobWithLock(admin, job.id, lockToken, {
    progress: 55,
    message: "Cleaning imported text",
  });
  const cleanedText = await cleanupImportedText(apiKey, importedText);
  if (!cleanedText) {
    throw new Error("Cleanup prompt returned empty text");
  }

  await updateJobWithLock(admin, job.id, lockToken, {
    progress: 72,
    message: "Converting to tour draft",
  });
  const converted = await convertCleanedTextToTourStop(apiKey, cleanedText);
  const candidates = await searchPlaces(converted.placeQuery, converted.cityHint, converted.countryHint, 3);
  const topCandidate = candidates[0] ?? null;

  const warnings = [draft.warning, transcriptResult.warning, candidates.length === 0 ? "Location confirmation required." : null]
    .filter((value): value is string => Boolean(toNullableTrimmed(value)))
    .join(" ");

  await updateDraft(admin, draft.id, {
    source_owner_title: metadata.ownerTitle,
    source_owner_user_id: metadata.ownerUserId,
    source_caption: metadata.caption,
    source_thumbnail_url: metadata.thumbnailUrl,
    transcript_raw: transcript,
    transcript_cleaned: cleanedText,
    generated_title: converted.title,
    generated_script: converted.script,
    place_query: converted.placeQuery,
    place_city_hint: converted.cityHint,
    place_country_hint: converted.countryHint,
    place_confidence: converted.confidence,
    suggested_place_label: topCandidate?.label ?? null,
    suggested_place_lat: topCandidate?.lat ?? null,
    suggested_place_lng: topCandidate?.lng ?? null,
    suggested_place_image_url: topCandidate?.imageUrl ?? null,
    suggested_google_place_id: topCandidate?.googlePlaceId ?? null,
    status: nextInstagramDraftStatus(draft.status, "import_succeeded"),
    warning: toNullableTrimmed(warnings),
    error: null,
  });

  await updateJobWithLock(admin, job.id, lockToken, {
    status: successJobStatusForPhase("import"),
    progress: 100,
    message: "Draft ready",
    error: null,
  });
}

async function createJam(admin: SupabaseClient) {
  const { data, error } = await admin
    .from("jams")
    .insert({
      host_name: "Rob",
      route_id: null,
      persona: "adult",
      current_stop: 0,
      is_playing: false,
      position_ms: 0,
      preset_id: null,
    })
    .select("id")
    .single();
  if (error || !data?.id) {
    throw new Error(error?.message || "Failed to create jam");
  }
  return data.id as string;
}

async function publishDraftToRoute(
  admin: SupabaseClient,
  draft: InstagramImportDraftRow
) {
  const finalTitle = resolveInstagramDraftTitle(buildDraftContent(draft));
  const finalScript = resolveInstagramDraftScript(buildDraftContent(draft));
  const confirmedPlace = makePlaceCandidate(
    draft.confirmed_place_label,
    draft.confirmed_place_lat,
    draft.confirmed_place_lng,
    draft.confirmed_place_image_url,
    draft.confirmed_google_place_id
  );
  if (!finalTitle || !finalScript || !confirmedPlace) {
    throw new Error("Draft is missing title, script, or confirmed place");
  }

  const apiKey = getOpenAiApiKey();
  const jamId = await createJam(admin);
  const city = toNullableTrimmed(draft.place_city_hint) || toNullableTrimmed(draft.place_country_hint) || "nearby";
  const routeLengthMinutes = estimateRouteLengthMinutes(finalScript);
  const routeStatus = "generating";
  const routeImage =
    confirmedPlace.imageUrl ||
    proxyGoogleImageUrl(draft.source_thumbnail_url) ||
    draft.source_thumbnail_url ||
    cityPlaceholderImage(city);

  const { data: routeRow, error: routeErr } = await admin
    .from("custom_routes")
    .insert({
      jam_id: jamId,
      city,
      transport_mode: "walk",
      length_minutes: routeLengthMinutes,
      title: finalTitle,
      narrator_default: "adult",
      narrator_guidance: null,
      narrator_voice: null,
      status: routeStatus,
      experience_kind: "mix",
    })
    .select("id")
    .single();
  if (routeErr || !routeRow?.id) {
    throw new Error(routeErr?.message || "Failed to create custom route");
  }
  const routeId = routeRow.id as string;
  const stopId = `ig-${draft.id.slice(0, 12)}`;

  const { error: jamErr } = await admin
    .from("jams")
    .update({
      route_id: `custom:${routeId}`,
      persona: "adult",
      current_stop: 0,
      completed_at: null,
      preset_id: null,
    })
    .eq("id", jamId);
  if (jamErr) {
    throw new Error(jamErr.message);
  }

  const { error: stopErr } = await admin
    .from("custom_route_stops")
    .insert({
      route_id: routeId,
      stop_id: stopId,
      position: 0,
      title: confirmedPlace.label,
      lat: confirmedPlace.lat,
      lng: confirmedPlace.lng,
      image_url: routeImage,
      stop_kind: "story",
      script_adult: finalScript,
      audio_url_adult: null,
    });
  if (stopErr) {
    throw new Error(stopErr.message);
  }

  const canonical = await ensureCanonicalStopForCustom(admin, city, {
    id: stopId,
    title: confirmedPlace.label,
    lat: confirmedPlace.lat,
    lng: confirmedPlace.lng,
    image: routeImage,
    ...(confirmedPlace.googlePlaceId ? { googlePlaceId: confirmedPlace.googlePlaceId } : {}),
  });
  await upsertRouteStopMapping(admin, "custom", routeId, stopId, canonical.id, 0);

  const audioBytes = await synthesizeSpeechWithOpenAI(apiKey, "adult", finalScript);
  const audioUrl = toNullableAudioUrl(await uploadNarrationAudio(audioBytes, `custom-${routeId}`, "adult", stopId));
  if (!audioUrl) {
    throw new Error("Failed to create narration audio URL");
  }

  await admin.from("canonical_stop_assets").upsert(
    {
      canonical_stop_id: canonical.id,
      persona: "adult",
      script: finalScript,
      audio_url: audioUrl,
      status: "ready",
      error: null,
    },
    { onConflict: "canonical_stop_id,persona" }
  );

  const { error: updateStopErr } = await admin
    .from("custom_route_stops")
    .update({
      script_adult: finalScript,
      audio_url_adult: audioUrl,
    })
    .eq("route_id", routeId)
    .eq("stop_id", stopId);
  if (updateStopErr) {
    throw new Error(updateStopErr.message);
  }

  const { error: readyErr } = await admin
    .from("custom_routes")
    .update({ status: "ready" })
    .eq("id", routeId);
  if (readyErr) {
    throw new Error(readyErr.message);
  }

  return { jamId, routeId };
}

async function processPublishJob(
  admin: SupabaseClient,
  job: InstagramImportJobRow,
  lockToken: string
) {
  const draft = await loadDraft(admin, job.draft_id);
  await updateDraft(admin, draft.id, {
    status: nextInstagramDraftStatus(draft.status, "publish_started"),
    error: null,
  });

  await updateJobWithLock(admin, job.id, lockToken, {
    progress: 30,
    message: "Publishing tour",
  });

  const { jamId, routeId } = await publishDraftToRoute(admin, draft);

  await updateDraft(admin, draft.id, {
    status: nextInstagramDraftStatus(draft.status, "publish_succeeded"),
    published_jam_id: jamId,
    published_route_id: routeId,
    error: null,
  });

  await updateJobWithLock(admin, job.id, lockToken, {
    status: successJobStatusForPhase("publish"),
    progress: 100,
    message: "Tour published",
    error: null,
  });
}

async function failJob(
  admin: SupabaseClient,
  job: InstagramImportJobRow,
  lockToken: string,
  message: string
) {
  const draft = await loadDraft(admin, job.draft_id);
  await updateDraft(admin, draft.id, {
    status: nextInstagramDraftStatus(draft.status, "job_failed"),
    error: message,
  });
  await updateJobWithLock(admin, job.id, lockToken, {
    status: "failed",
    progress: 100,
    message: job.phase === "import" ? "Import failed" : "Publish failed",
    error: message,
  });
}

async function processClaimedJob(
  admin: SupabaseClient,
  job: InstagramImportJobRow,
  lockToken: string
) {
  try {
    if (job.phase === "import") {
      await processImportJob(admin, job, lockToken);
      return;
    }
    await processPublishJob(admin, job, lockToken);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Instagram import job failure";
    console.error("instagram import job failed", {
      jobId: job.id,
      draftId: job.draft_id,
      phase: job.phase,
      error: message,
    });
    await failJob(admin, job, lockToken, message);
  }
}

export async function processQueuedInstagramImportJobs(
  limit = DEFAULT_WORKER_LIMIT,
  admin: SupabaseClient = getSupabaseAdminClient()
) {
  const max = Math.max(1, Math.min(10, Math.floor(limit) || DEFAULT_WORKER_LIMIT));
  let processed = 0;

  for (let i = 0; i < max; i += 1) {
    const claimed = await claimNextJob(admin);
    if (!claimed) break;
    processed += 1;
    await processClaimedJob(admin, claimed.job, claimed.lockToken);
  }

  return { processed };
}
