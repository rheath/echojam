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
import { buildPlaceGroundingSignature } from "@/lib/placeGrounding";
import {
  buildInstagramScriptGenerationSourceText,
  composeInstagramImportSourceText,
  deriveInstagramRouteAttribution,
  deriveInstagramCollectionRouteTitle,
  estimateTextTokenCount,
  instagramRouteStopIdForDraft,
  INSTAGRAM_COLLECTION_MAX_STOPS,
  INSTAGRAM_IMPORT_MAX_SPLIT_STOPS,
  isInstagramDraftPublishable,
  normalizeInstagramImportJobDraftIds,
  parseInstagramTourStopConversions,
  type InstagramDraftContent,
  type InstagramImportDraftStatus,
  type InstagramImportJobPhase,
  type InstagramScriptGenerationSources,
  normalizeInstagramCollectionDraftIds,
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
  isUsableGeneratedAudioUrl,
  synthesizeSpeechWithOpenAI,
  toNullableAudioUrl,
  uploadNarrationAudio,
} from "@/lib/mixGeneration";
import { fetchInstagramProfileImageUrl } from "@/lib/server/instagramProfileImage";
import {
  buildPlaceLocationLabel,
  type GooglePlaceAddressComponent,
} from "@/lib/server/placeLocationLabel";
import { resolvePlaceGrounding } from "@/lib/server/placeGroundingResolver";
import { generateGroundedSocialScriptWithOpenAI } from "@/lib/server/socialScriptGrounding";
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
  draft_ids: string[] | null;
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

type GooglePlaceSearchResponse = {
  places?: Array<{
    id?: string;
    name?: string;
    displayName?: { text?: string };
    location?: { latitude?: number; longitude?: number };
    addressComponents?: GooglePlaceAddressComponent[];
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
  draft_ids,
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

const JOB_SELECT_LEGACY = `
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

function isMissingDraftIdsColumnError(message: string | null | undefined) {
  const normalized = (message || "").toLowerCase();
  return normalized.includes("draft_ids") && normalized.includes("does not exist");
}

function toInstagramImportJobRow(row: Record<string, unknown>) {
  return {
    ...(row as Omit<InstagramImportJobRow, "draft_ids">),
    draft_ids: Array.isArray(row.draft_ids) ? (row.draft_ids as string[]) : null,
  } satisfies InstagramImportJobRow;
}

export function getInstagramDraftIdsMigrationError() {
  return "Instagram master publish requires the draft_ids migration. Run the latest Supabase migration and try again.";
}

function isMissingCustomRouteStoryByColumnError(message: string | null | undefined) {
  const normalized = (message || "").toLowerCase();
  const isStoryByLookup =
    normalized.includes("story_by") ||
    normalized.includes("story_by_url") ||
    normalized.includes("story_by_avatar_url") ||
    normalized.includes("story_by_source");
  return (
    isStoryByLookup &&
    ((normalized.includes("column") && normalized.includes("does not exist")) ||
      (normalized.includes("could not find") && normalized.includes("schema cache")))
  );
}

async function resolveInstagramRouteAttributionForDrafts(drafts: InstagramImportDraftRow[]) {
  const baseAttribution = deriveInstagramRouteAttribution(
    drafts.map((draft) => ({
      ownerTitle: draft.source_owner_title,
    }))
  );
  if (!baseAttribution.storyBy || !baseAttribution.storyByUrl || baseAttribution.isCollective) {
    return baseAttribution;
  }

  const storyByAvatarUrl =
    (await fetchInstagramProfileImageUrl(baseAttribution.storyByUrl).catch(() => null)) || null;
  return {
    ...baseAttribution,
    storyByAvatarUrl,
  };
}

async function createInstagramCustomRoute(
  admin: SupabaseClient,
  payload: {
    jam_id: string;
    city: string;
    transport_mode: "walk";
    length_minutes: number;
    title: string;
    narrator_default: "adult";
    narrator_guidance: null;
    narrator_voice: null;
    status: "generating";
    experience_kind: "mix";
    story_by: string | null;
    story_by_url: string | null;
    story_by_avatar_url: string | null;
    story_by_source: "instagram" | null;
  }
) {
  const { data: routeWithAttribution, error: routeWithAttributionErr } = await admin
    .from("custom_routes")
    .insert(payload)
    .select("id")
    .single();

  if (!routeWithAttributionErr && routeWithAttribution?.id) {
    return routeWithAttribution.id as string;
  }

  if (!isMissingCustomRouteStoryByColumnError(routeWithAttributionErr?.message)) {
    throw new Error(routeWithAttributionErr?.message || "Failed to create custom route");
  }

  const legacyPayload = {
    jam_id: payload.jam_id,
    city: payload.city,
    transport_mode: payload.transport_mode,
    length_minutes: payload.length_minutes,
    title: payload.title,
    narrator_default: payload.narrator_default,
    narrator_guidance: payload.narrator_guidance,
    narrator_voice: payload.narrator_voice,
    status: payload.status,
    experience_kind: payload.experience_kind,
  };
  const { data: legacyRoute, error: legacyRouteErr } = await admin
    .from("custom_routes")
    .insert(legacyPayload)
    .select("id")
    .single();
  if (legacyRouteErr || !legacyRoute?.id) {
    throw new Error(legacyRouteErr?.message || "Failed to create custom route");
  }
  return legacyRoute.id as string;
}

function getOpenAiApiKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required.");
  return apiKey;
}

function estimateRouteLengthMinutes(script: string) {
  const words = script.split(/\s+/).filter(Boolean).length;
  return Math.max(5, Math.min(30, Math.round(words / 120) || 5));
}

function estimateRouteLengthMinutesForScripts(scripts: string[]) {
  return estimateRouteLengthMinutes(scripts.join("\n\n"));
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
  formattedAddress: string | null = null,
  locationLabel: string | null = null
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
    locationLabel,
  };
}

export function serializeInstagramJob(job: InstagramImportJobRow | null) {
  if (!job) return null;
  return {
    id: job.id,
    draftId: job.draft_id,
    draftIds: getJobDraftIds(job),
    phase: job.phase,
    status: job.status,
    progress: job.progress,
    message: job.message,
    error: job.error,
    attempts: job.attempts,
    updatedAt: job.updated_at,
  };
}

function getJobDraftIds(job: InstagramImportJobRow) {
  return normalizeInstagramImportJobDraftIds(job.phase, job.draft_id, job.draft_ids);
}

export function serializeInstagramDraft(
  row: InstagramImportDraftRow,
  latestJob: InstagramImportJobRow | null
) {
  const finalScript = resolveInstagramDraftScript(buildDraftContent(row));
  const extractedText = composeInstagramImportSourceText(row.source_caption, row.transcript_raw);
  const normalizedStatus =
    row.published_jam_id && row.published_route_id
      ? "published"
      : row.status;

  return {
    id: row.id,
    status: normalizedStatus,
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
    grounding: {
      confirmedPlaceId: row.confirmed_google_place_id,
      signature:
        row.confirmed_place_label || row.confirmed_google_place_id
          ? buildPlaceGroundingSignature({
              placeId: row.confirmed_google_place_id,
              resolvedName: row.confirmed_place_label,
              formattedAddress: null,
            })
          : null,
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

async function convertCleanedTextToTourStops(
  apiKey: string,
  sources: InstagramScriptGenerationSources
) {
  const promptSourceText = buildInstagramScriptGenerationSourceText(sources);
  if (!promptSourceText) {
    throw new Error("Script generation sources were empty");
  }

  const systemPrompt = [
    "You convert travel source material into one to five ordered EchoJam tour stops.",
    "Use the transcript for narrative flow, spoken details, and sequencing when it is available.",
    "Use the caption to add place names, logistics, concrete facts, and context when it is available.",
    "Treat cleaned notes as supporting context, but do not ignore transcript or caption.",
    "If transcript and caption disagree, prefer the most concrete factual details.",
    "When the source clearly moves across multiple meaningful locations or beats, split it into multiple ordered stops.",
    "Keep single-place stories as exactly one stop.",
    "Do not create filler stops or route summaries.",
    "Do not invent locations or details.",
    "Return strict JSON only.",
  ].join(" ");

  const userPrompt = [
    `Convert this Instagram source into an ordered list of 1 to ${INSTAGRAM_IMPORT_MAX_SPLIT_STOPS} draft stops.`,
    "Use both transcript and caption together when both are available.",
    "Output strict JSON with one top-level key: stops.",
    "stops must be an ordered array.",
    "Each stop must include: title, script, placeQuery, cityHint, countryHint, confidence.",
    "title: a short user-facing stop title.",
    "script: 90-180 words of spoken tour narration for that stop only.",
    "placeQuery: the best single place search query for Google Places for that stop.",
    "cityHint: the most likely city or region if known, else null.",
    "countryHint: the most likely country if known, else null.",
    "confidence: number from 0 to 1.",
    "Use null for unknown hints.",
    "Preserve chronological order when there are multiple stops.",
    "",
    promptSourceText,
  ].join("\n");

  const raw = await runChatCompletion(apiKey, systemPrompt, userPrompt);
  if (!raw) {
    throw new Error("Tour stop conversion returned empty output");
  }
  return parseInstagramTourStopConversions(raw, INSTAGRAM_IMPORT_MAX_SPLIT_STOPS);
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
          "places.id,places.name,places.displayName,places.location,places.addressComponents,places.formattedAddress",
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
        locationLabel: buildPlaceLocationLabel({
          addressComponents: place.addressComponents,
          formattedAddress: place.formattedAddress,
        }),
      });
      if (results.length >= limit) return results;
    }
  }

  return results;
}

export async function searchInstagramImportPlacesByQuery(
  query: string,
  cityHint: string | null,
  countryHint: string | null,
  limit = 5
) {
  return await searchPlaces(query, cityHint, countryHint, limit);
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

async function loadDraftsByIds(admin: SupabaseClient, draftIds: string[]) {
  const normalizedDraftIds = normalizeInstagramCollectionDraftIds(draftIds, INSTAGRAM_COLLECTION_MAX_STOPS);
  const { data, error } = await admin
    .from("instagram_import_drafts")
    .select(DRAFT_SELECT)
    .in("id", normalizedDraftIds);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as InstagramImportDraftRow[];
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const ordered = normalizedDraftIds.map((draftId) => rowsById.get(draftId) ?? null);
  const missingDraftId = normalizedDraftIds.find((draftId) => !rowsById.has(draftId));
  if (missingDraftId) {
    throw new Error("Instagram draft not found");
  }
  return ordered as InstagramImportDraftRow[];
}

async function loadLatestJobForDraft(admin: SupabaseClient, draftId: string) {
  const query = admin
    .from("instagram_import_jobs")
    .select(JOB_SELECT)
    .eq("draft_id", draftId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { data, error } = await query;
  if (!error) return data ? toInstagramImportJobRow(data) : null;
  if (!isMissingDraftIdsColumnError(error.message)) throw new Error(error.message);

  const legacy = await admin
    .from("instagram_import_jobs")
    .select(JOB_SELECT_LEGACY)
    .eq("draft_id", draftId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (legacy.error) throw new Error(legacy.error.message);
  return legacy.data ? toInstagramImportJobRow(legacy.data) : null;
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

export async function updateInstagramDraftById(
  draftId: string,
  patch: Partial<InstagramImportDraftRow>,
  admin: SupabaseClient = getSupabaseAdminClient()
) {
  await updateDraft(admin, draftId, patch);
  return await getInstagramDraftResponseById(draftId, admin);
}

export async function regenerateInstagramDraftForConfirmedPlace(
  draftId: string,
  admin: SupabaseClient = getSupabaseAdminClient(),
  options?: { force?: boolean }
) {
  const draft = await loadDraft(admin, draftId);
  if (toNullableTrimmed(draft.edited_script) && !options?.force) {
    return await getInstagramDraftResponseById(draftId, admin);
  }

  const confirmedPlace = makePlaceCandidate(
    draft.confirmed_place_label,
    draft.confirmed_place_lat,
    draft.confirmed_place_lng,
    draft.confirmed_place_image_url,
    draft.confirmed_google_place_id
  );
  if (!confirmedPlace) {
    return await getInstagramDraftResponseById(draftId, admin);
  }

  const placeGrounding = await resolvePlaceGrounding({
    title: confirmedPlace.label,
    googlePlaceId: confirmedPlace.googlePlaceId,
    lat: confirmedPlace.lat,
    lng: confirmedPlace.lng,
    formattedAddress: confirmedPlace.formattedAddress,
  });
  if (!placeGrounding) {
    return await getInstagramDraftResponseById(draftId, admin);
  }

  const apiKey = getOpenAiApiKey();
  const grounded = await generateGroundedSocialScriptWithOpenAI(
    apiKey,
    "Instagram",
    {
      caption: draft.source_caption,
      transcript: draft.transcript_raw,
      cleanedText: draft.transcript_cleaned,
    },
    resolveInstagramDraftTitle(buildDraftContent(draft)),
    placeGrounding
  );

  await updateDraft(admin, draftId, {
    generated_title: grounded.title,
    generated_script: grounded.script,
    place_query: confirmedPlace.label,
    place_city_hint: placeGrounding.city,
    place_country_hint: placeGrounding.country,
    place_confidence: 1,
    error: null,
  });

  return await getInstagramDraftResponseById(draftId, admin);
}

export async function createInstagramImportJob(
  draftId: string,
  phase: InstagramImportJobPhase,
  admin: SupabaseClient = getSupabaseAdminClient(),
  opts?: { draftIds?: string[] | null; message?: string | null }
) {
  const normalizedDraftIds =
    phase === "publish_collection"
      ? normalizeInstagramCollectionDraftIds(opts?.draftIds ?? [draftId], INSTAGRAM_COLLECTION_MAX_STOPS)
      : phase === "import"
        ? normalizeInstagramCollectionDraftIds(opts?.draftIds ?? [draftId], INSTAGRAM_IMPORT_MAX_SPLIT_STOPS)
        : normalizeInstagramCollectionDraftIds([draftId], 1);
  const insertPayload: Record<string, unknown> = {
    draft_id: draftId,
    phase,
    status: "queued",
    progress: 0,
    message:
      toNullableTrimmed(opts?.message) ||
      (phase === "import"
        ? "Queued for import"
        : phase === "publish_collection"
          ? "Queued for master publish"
          : "Queued for publish"),
    error: null,
  };
  if (normalizedDraftIds) {
    insertPayload.draft_ids = normalizedDraftIds;
  }

  const { data, error } = await admin
    .from("instagram_import_jobs")
    .insert(insertPayload)
    .select(JOB_SELECT)
    .single();
  if (!error && data) return toInstagramImportJobRow(data);
  if (!isMissingDraftIdsColumnError(error?.message)) {
    throw new Error(error?.message || "Failed to create Instagram import job");
  }
  if (phase === "publish_collection") {
    throw new Error(getInstagramDraftIdsMigrationError());
  }

  const legacyResult = await admin
    .from("instagram_import_jobs")
    .insert({
      draft_id: draftId,
      phase,
      status: "queued",
      progress: 0,
      message:
        toNullableTrimmed(opts?.message) ||
        (phase === "import" ? "Queued for import" : "Queued for publish"),
      error: null,
    })
    .select(JOB_SELECT_LEGACY)
    .single();
  if (legacyResult.error || !legacyResult.data) {
    throw new Error(legacyResult.error?.message || "Failed to create Instagram import job");
  }
  return toInstagramImportJobRow(legacyResult.data);
}

function extractCollectionRouteTitleFromJobMessage(message: string | null | undefined) {
  const normalized = toNullableTrimmed(message);
  const prefix = "Queued for master publish:";
  if (!normalized || !normalized.startsWith(prefix)) return null;
  return toNullableTrimmed(normalized.slice(prefix.length));
}

function extractCollectionPublishOptionsFromJobMessage(message: string | null | undefined) {
  const normalized = toNullableTrimmed(message);
  if (!normalized) {
    return {
      routeTitle: null,
      existingRouteId: null,
    };
  }

  const routeMatch = normalized.match(/^Queued for master publish\s+\[route:([^\]]+)\]\s*:\s*(.+)$/);
  if (routeMatch) {
    return {
      existingRouteId: toNullableTrimmed(routeMatch[1]),
      routeTitle: toNullableTrimmed(routeMatch[2]),
    };
  }

  return {
    existingRouteId: null,
    routeTitle: extractCollectionRouteTitleFromJobMessage(normalized),
  };
}

function getInstagramImportClaimMessage(job: Pick<InstagramImportJobRow, "phase" | "message">) {
  if (job.phase === "publish_collection") {
    return toNullableTrimmed(job.message) || "Publishing collection";
  }
  return job.phase === "import" ? "Importing Instagram post" : "Publishing draft";
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

async function updateDrafts(
  admin: SupabaseClient,
  draftIds: string[],
  patch: Partial<InstagramImportDraftRow>
) {
  if (draftIds.length === 0) return;
  const { error } = await admin
    .from("instagram_import_drafts")
    .update(patch)
    .in("id", draftIds);
  if (error) throw new Error(error.message);
}

async function claimNextJob(admin: SupabaseClient) {
  const queuedResult = await admin
    .from("instagram_import_jobs")
    .select(JOB_SELECT)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  let candidate: InstagramImportJobRow | null = null;
  let legacyMode = false;
  if (!queuedResult.error) {
    candidate = queuedResult.data ? toInstagramImportJobRow(queuedResult.data) : null;
  } else if (isMissingDraftIdsColumnError(queuedResult.error.message)) {
    legacyMode = true;
    const legacyQueued = await admin
      .from("instagram_import_jobs")
      .select(JOB_SELECT_LEGACY)
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (legacyQueued.error) throw new Error(legacyQueued.error.message);
    candidate = legacyQueued.data ? toInstagramImportJobRow(legacyQueued.data) : null;
  } else {
    throw new Error(queuedResult.error.message);
  }

  if (!candidate) {
    const staleBefore = new Date(Date.now() - JOB_STALE_MS).toISOString();
    const stale = legacyMode
      ? await admin
          .from("instagram_import_jobs")
          .select(JOB_SELECT_LEGACY)
          .eq("status", "processing")
          .lt("locked_at", staleBefore)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle()
      : await admin
          .from("instagram_import_jobs")
          .select(JOB_SELECT)
          .eq("status", "processing")
          .lt("locked_at", staleBefore)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
    if (stale.error) {
      if (!legacyMode && isMissingDraftIdsColumnError(stale.error.message)) {
        const legacyStale = await admin
          .from("instagram_import_jobs")
          .select(JOB_SELECT_LEGACY)
          .eq("status", "processing")
          .lt("locked_at", staleBefore)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (legacyStale.error) throw new Error(legacyStale.error.message);
        candidate = legacyStale.data ? toInstagramImportJobRow(legacyStale.data) : null;
        legacyMode = true;
      } else {
        throw new Error(stale.error.message);
      }
    } else {
      candidate = stale.data ? toInstagramImportJobRow(stale.data) : null;
    }
  }
  if (!candidate) return null;

  const lockToken = randomUUID();
  const now = new Date().toISOString();
  const claimPatch = {
    status: "processing" as const,
    progress: Math.max(candidate.progress || 0, 5),
    message: getInstagramImportClaimMessage(candidate),
    error: null,
    attempts: (candidate.attempts || 0) + 1,
    locked_at: now,
    last_heartbeat_at: now,
    lock_token: lockToken,
  };
  const claimedResult = legacyMode
    ? await admin
        .from("instagram_import_jobs")
        .update(claimPatch)
        .eq("id", candidate.id)
        .eq("status", candidate.status)
        .select(JOB_SELECT_LEGACY)
        .maybeSingle()
    : await admin
        .from("instagram_import_jobs")
        .update(claimPatch)
        .eq("id", candidate.id)
        .eq("status", candidate.status)
        .select(JOB_SELECT)
        .maybeSingle();
  if (claimedResult.error) {
    if (!legacyMode && isMissingDraftIdsColumnError(claimedResult.error.message)) {
      const legacyClaimed = await admin
        .from("instagram_import_jobs")
        .update(claimPatch)
        .eq("id", candidate.id)
        .eq("status", candidate.status)
        .select(JOB_SELECT_LEGACY)
        .maybeSingle();
      if (legacyClaimed.error || !legacyClaimed.data) return null;
      return { job: toInstagramImportJobRow(legacyClaimed.data), lockToken };
    }
    return null;
  }
  if (!claimedResult.data) return null;
  return { job: toInstagramImportJobRow(claimedResult.data), lockToken };
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
    message: "Converting to tour stops",
  });
  const convertedStops = await convertCleanedTextToTourStops(apiKey, {
    caption: metadata.caption,
    transcript,
    cleanedText,
  });
  const placeCandidatesByStop = await Promise.all(
    convertedStops.map(async (convertedStop) => ({
      convertedStop,
      candidates: await searchPlaces(
        convertedStop.placeQuery,
        convertedStop.cityHint,
        convertedStop.countryHint,
        3
      ),
    }))
  );

  const siblingDraftIds =
    convertedStops.length > 1
      ? (
          await admin
            .from("instagram_import_drafts")
            .insert(
              convertedStops.slice(1).map(() => ({
                source_url: draft.source_url,
                source_kind: draft.source_kind,
                source_shortcode: draft.source_shortcode,
                status: "pending_import",
              }))
            )
            .select("id")
        )
      : null;
  if (siblingDraftIds?.error) {
    throw new Error(siblingDraftIds.error.message || "Failed to create Instagram sibling drafts");
  }
  const orderedDraftIds = [
    draft.id,
    ...((siblingDraftIds?.data ?? []).map((row) => toNullableTrimmed((row as { id?: string }).id)).filter(
      (value): value is string => Boolean(value)
    )),
  ];
  if (orderedDraftIds.length !== convertedStops.length) {
    throw new Error("Failed to materialize every imported Instagram stop");
  }

  await updateJobWithLock(admin, job.id, lockToken, {
    draft_ids: orderedDraftIds,
  });

  const importSucceededStatus = nextInstagramDraftStatus("pending_import", "import_succeeded");
  await Promise.all(
    placeCandidatesByStop.map(async ({ convertedStop, candidates }, index) => {
      const topCandidate = candidates[0] ?? null;
      const warnings = [
        index === 0 ? draft.warning : null,
        index === 0 ? transcriptResult.warning : null,
        candidates.length === 0 ? "Location confirmation required." : null,
      ]
        .filter((value): value is string => Boolean(toNullableTrimmed(value)))
        .join(" ");

      await updateDraft(admin, orderedDraftIds[index]!, {
        source_owner_title: metadata.ownerTitle,
        source_owner_user_id: metadata.ownerUserId,
        source_caption: metadata.caption,
        source_thumbnail_url: metadata.thumbnailUrl,
        transcript_raw: transcript,
        transcript_cleaned: cleanedText,
        generated_title: convertedStop.title,
        generated_script: convertedStop.script,
        place_query: convertedStop.placeQuery,
        place_city_hint: convertedStop.cityHint,
        place_country_hint: convertedStop.countryHint,
        place_confidence: convertedStop.confidence,
        suggested_place_label: topCandidate?.label ?? null,
        suggested_place_lat: topCandidate?.lat ?? null,
        suggested_place_lng: topCandidate?.lng ?? null,
        suggested_place_image_url: topCandidate?.imageUrl ?? null,
        suggested_google_place_id: topCandidate?.googlePlaceId ?? null,
        status: index === 0 ? nextInstagramDraftStatus(draft.status, "import_succeeded") : importSucceededStatus,
        warning: toNullableTrimmed(warnings),
        error: null,
      });
    })
  );

  await updateJobWithLock(admin, job.id, lockToken, {
    status: successJobStatusForPhase("import"),
    progress: 100,
    message: convertedStops.length > 1 ? `Drafts ready (${convertedStops.length} stops)` : "Draft ready",
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

type PublishableInstagramDraft = {
  stopId: string;
  city: string;
  finalTitle: string;
  finalScript: string;
  confirmedPlace: InstagramPlaceCandidate;
  routeImage: string;
};

type ExistingPublishedInstagramStopRow = {
  stop_id: string;
  position?: number | null;
  script_adult: string | null;
  audio_url_adult: string | null;
};

type ExistingInstagramRouteRow = {
  id: string;
  jam_id: string;
  story_by_avatar_url: string | null;
};

function buildPublishableInstagramDraft(draft: InstagramImportDraftRow): PublishableInstagramDraft {
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

  const city =
    toNullableTrimmed(draft.place_city_hint) ||
    toNullableTrimmed(draft.place_country_hint) ||
    "nearby";

  const routeImage =
    confirmedPlace.imageUrl ||
    proxyGoogleImageUrl(draft.source_thumbnail_url) ||
    draft.source_thumbnail_url ||
    cityPlaceholderImage(city);

  return {
    stopId: instagramRouteStopIdForDraft(draft.id),
    city,
    finalTitle,
    finalScript,
    confirmedPlace,
    routeImage,
  };
}

async function updateInstagramCustomRouteMetadata(
  admin: SupabaseClient,
  routeId: string,
  payload: {
    city: string;
    length_minutes: number;
    title: string;
    narrator_default: "adult";
    narrator_guidance: null;
    narrator_voice: null;
    status: "generating" | "ready";
    experience_kind: "mix";
    story_by: string | null;
    story_by_url: string | null;
    story_by_avatar_url: string | null;
    story_by_source: "instagram" | null;
  }
) {
  const { error } = await admin
    .from("custom_routes")
    .update(payload)
    .eq("id", routeId);
  if (!error) return;

  if (!isMissingCustomRouteStoryByColumnError(error.message)) {
    throw new Error(error.message);
  }

  const { error: legacyError } = await admin
    .from("custom_routes")
    .update({
      city: payload.city,
      length_minutes: payload.length_minutes,
      title: payload.title,
      narrator_default: payload.narrator_default,
      narrator_guidance: payload.narrator_guidance,
      narrator_voice: payload.narrator_voice,
      status: payload.status,
      experience_kind: payload.experience_kind,
    })
    .eq("id", routeId);
  if (legacyError) {
    throw new Error(legacyError.message);
  }
}

async function upsertInstagramRouteStop(
  admin: SupabaseClient,
  routeId: string,
  publishableDraft: PublishableInstagramDraft,
  position: number
) {
  const patch = {
    position,
    title: publishableDraft.finalTitle,
    lat: publishableDraft.confirmedPlace.lat,
    lng: publishableDraft.confirmedPlace.lng,
    image_url: publishableDraft.routeImage,
    stop_kind: "story" as const,
    script_adult: publishableDraft.finalScript,
    audio_url_adult: null,
  };

  const { data: existingStop, error: existingStopErr } = await admin
    .from("custom_route_stops")
    .select("stop_id")
    .eq("route_id", routeId)
    .eq("stop_id", publishableDraft.stopId)
    .maybeSingle();
  if (existingStopErr) {
    throw new Error(existingStopErr.message);
  }

  if (existingStop?.stop_id) {
    const { error: updateErr } = await admin
      .from("custom_route_stops")
      .update(patch)
      .eq("route_id", routeId)
      .eq("stop_id", publishableDraft.stopId);
    if (updateErr) {
      throw new Error(updateErr.message);
    }
    return;
  }

  const { error: insertErr } = await admin
    .from("custom_route_stops")
    .insert({
      route_id: routeId,
      stop_id: publishableDraft.stopId,
      ...patch,
    });
  if (insertErr) {
    throw new Error(insertErr.message);
  }
}

async function loadExistingPublishedInstagramStops(
  admin: SupabaseClient,
  routeId: string
) {
  const { data, error } = await admin
    .from("custom_route_stops")
    .select("stop_id,position,script_adult,audio_url_adult")
    .eq("route_id", routeId);
  if (error) {
    throw new Error(error.message);
  }

  const rows = (data ?? []) as ExistingPublishedInstagramStopRow[];
  return new Map(rows.map((row) => [row.stop_id, row]));
}

async function stageExistingInstagramRouteStopPositions(
  admin: SupabaseClient,
  routeId: string,
  existingStopsById: Map<string, ExistingPublishedInstagramStopRow>
) {
  const stagedStops = Array.from(existingStopsById.values()).sort(
    (left, right) => (left.position ?? 0) - (right.position ?? 0)
  );

  for (let index = 0; index < stagedStops.length; index += 1) {
    const stop = stagedStops[index];
    const { error } = await admin
      .from("custom_route_stops")
      .update({ position: 10_000 + index })
      .eq("route_id", routeId)
      .eq("stop_id", stop.stop_id);
    if (error) {
      throw new Error(error.message);
    }
  }
}

async function loadExistingInstagramRoute(
  admin: SupabaseClient,
  routeId: string
) {
  const routeWithAttribution = await admin
    .from("custom_routes")
    .select("id,jam_id,story_by_avatar_url")
    .eq("id", routeId)
    .single();

  if (!routeWithAttribution.error && routeWithAttribution.data) {
    return routeWithAttribution.data as ExistingInstagramRouteRow;
  }

  if (!isMissingCustomRouteStoryByColumnError(routeWithAttribution.error?.message)) {
    throw new Error(routeWithAttribution.error?.message || "Instagram route was not found");
  }

  const legacyRoute = await admin
    .from("custom_routes")
    .select("id,jam_id")
    .eq("id", routeId)
    .single();
  if (legacyRoute.error || !legacyRoute.data) {
    throw new Error(legacyRoute.error?.message || "Instagram route was not found");
  }

  return {
    ...(legacyRoute.data as Omit<ExistingInstagramRouteRow, "story_by_avatar_url">),
    story_by_avatar_url: null,
  } satisfies ExistingInstagramRouteRow;
}

async function publishDraftToRoute(
  admin: SupabaseClient,
  draft: InstagramImportDraftRow
) {
  const publishableDraft = buildPublishableInstagramDraft(draft);
  const { finalTitle, finalScript, confirmedPlace, city, routeImage, stopId } = publishableDraft;

  const apiKey = getOpenAiApiKey();
  const jamId = await createJam(admin);
  const routeLengthMinutes = estimateRouteLengthMinutes(finalScript);
  const routeStatus = "generating";
  const attribution = await resolveInstagramRouteAttributionForDrafts([draft]);
  const routeId = await createInstagramCustomRoute(admin, {
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
    story_by: attribution.storyBy,
    story_by_url: attribution.storyByUrl,
    story_by_avatar_url: attribution.storyByAvatarUrl,
    story_by_source: attribution.storyBySource,
  });

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

async function publishDraftCollectionToRoute(
  admin: SupabaseClient,
  drafts: InstagramImportDraftRow[],
  routeTitle: string | null,
  existingRouteId: string | null,
  onProgress?: (progress: number, message: string) => Promise<void>
) {
  const publishableDrafts = drafts.map(buildPublishableInstagramDraft);
  const apiKey = getOpenAiApiKey();
  const city =
    publishableDrafts.find((draft) => draft.city !== "nearby")?.city ||
    publishableDrafts[0]?.city ||
    "nearby";
  const resolvedRouteTitle =
    deriveInstagramCollectionRouteTitle(
      routeTitle,
      publishableDrafts.length,
      publishableDrafts[0]?.finalTitle ?? null
    ) || publishableDrafts[0]?.finalTitle;
  if (!resolvedRouteTitle) {
    throw new Error("Route title was empty");
  }

  await onProgress?.(18, "Creating route");
  const attribution = await resolveInstagramRouteAttributionForDrafts(drafts);
  const routeLengthMinutes = estimateRouteLengthMinutesForScripts(
    publishableDrafts.map((draft) => draft.finalScript)
  );
  let jamId: string;
  let routeId: string;
  let existingStopsById = new Map<string, ExistingPublishedInstagramStopRow>();
  let resolvedRouteAvatarUrl = attribution.storyByAvatarUrl;

  if (existingRouteId) {
    const existingRoute = await loadExistingInstagramRoute(admin, existingRouteId);
    jamId = existingRoute.jam_id;
    routeId = existingRoute.id;
    resolvedRouteAvatarUrl = attribution.storyByAvatarUrl || existingRoute.story_by_avatar_url || null;
    existingStopsById = await loadExistingPublishedInstagramStops(admin, routeId);
    await stageExistingInstagramRouteStopPositions(admin, routeId, existingStopsById);
    await updateInstagramCustomRouteMetadata(admin, routeId, {
      city,
      length_minutes: routeLengthMinutes,
      title: resolvedRouteTitle,
      narrator_default: "adult",
      narrator_guidance: null,
      narrator_voice: null,
      status: "generating",
      experience_kind: "mix",
      story_by: attribution.storyBy,
      story_by_url: attribution.storyByUrl,
      story_by_avatar_url: resolvedRouteAvatarUrl,
      story_by_source: attribution.storyBySource,
    });
  } else {
    jamId = await createJam(admin);
    routeId = await createInstagramCustomRoute(admin, {
      jam_id: jamId,
      city,
      transport_mode: "walk",
      length_minutes: routeLengthMinutes,
      title: resolvedRouteTitle,
      narrator_default: "adult",
      narrator_guidance: null,
      narrator_voice: null,
      status: "generating",
      experience_kind: "mix",
      story_by: attribution.storyBy,
      story_by_url: attribution.storyByUrl,
      story_by_avatar_url: attribution.storyByAvatarUrl,
      story_by_source: attribution.storyBySource,
    });
  }

  const { error: jamErr } = await admin
    .from("jams")
    .update({
      route_id: `custom:${routeId}`,
      persona: "adult",
      current_stop: 0,
      completed_at: null,
      preset_id: null,
      is_playing: false,
      position_ms: 0,
    })
    .eq("id", jamId);
  if (jamErr) {
    throw new Error(jamErr.message);
  }

  await onProgress?.(34, `Adding stops (0/${publishableDrafts.length})`);
  const desiredStopIds = publishableDrafts.map((publishableDraft) => publishableDraft.stopId);

  for (let index = 0; index < publishableDrafts.length; index += 1) {
    const publishableDraft = publishableDrafts[index];
    await upsertInstagramRouteStop(admin, routeId, publishableDraft, index);
    const canonical = await ensureCanonicalStopForCustom(admin, city, {
      id: publishableDraft.stopId,
      title: publishableDraft.confirmedPlace.label,
      lat: publishableDraft.confirmedPlace.lat,
      lng: publishableDraft.confirmedPlace.lng,
      image: publishableDraft.routeImage,
      ...(publishableDraft.confirmedPlace.googlePlaceId
        ? { googlePlaceId: publishableDraft.confirmedPlace.googlePlaceId }
        : {}),
    });
    await upsertRouteStopMapping(
      admin,
      "custom",
      routeId,
      publishableDraft.stopId,
      canonical.id,
      index
    );

    await onProgress?.(
      40 + Math.round(((index + 1) / publishableDrafts.length) * 55),
      `Generating audio (${index + 1}/${publishableDrafts.length})`
    );

    const existingStop = existingStopsById.get(publishableDraft.stopId) ?? null;
    const existingScript = toNullableTrimmed(existingStop?.script_adult);
    const existingAudioUrl = toNullableAudioUrl(existingStop?.audio_url_adult);
    const shouldReuseAudio =
      existingScript === publishableDraft.finalScript && isUsableGeneratedAudioUrl(existingAudioUrl);

    const audioUrl = shouldReuseAudio
      ? existingAudioUrl
      : toNullableAudioUrl(
          await uploadNarrationAudio(
            await synthesizeSpeechWithOpenAI(
              apiKey,
              "adult",
              publishableDraft.finalScript
            ),
            `custom-${routeId}`,
            "adult",
            publishableDraft.stopId
          )
        );
    if (!audioUrl) {
      throw new Error("Failed to create narration audio URL");
    }

    await admin.from("canonical_stop_assets").upsert(
      {
        canonical_stop_id: canonical.id,
        persona: "adult",
        script: publishableDraft.finalScript,
        audio_url: audioUrl,
        status: "ready",
        error: null,
      },
      { onConflict: "canonical_stop_id,persona" }
    );

    const { error: updateStopErr } = await admin
      .from("custom_route_stops")
      .update({
        script_adult: publishableDraft.finalScript,
        audio_url_adult: audioUrl,
      })
      .eq("route_id", routeId)
      .eq("stop_id", publishableDraft.stopId);
    if (updateStopErr) {
      throw new Error(updateStopErr.message);
    }
  }

  if (existingRouteId) {
    const quotedStopIds = desiredStopIds.map((stopId) => JSON.stringify(stopId)).join(",");

    const { error: deleteStopsErr } = await admin
      .from("custom_route_stops")
      .delete()
      .eq("route_id", routeId)
      .not("stop_id", "in", `(${quotedStopIds})`);
    if (deleteStopsErr) {
      throw new Error(deleteStopsErr.message);
    }

    const { error: deleteMappingsErr } = await admin
      .from("route_stop_mappings")
      .delete()
      .eq("route_kind", "custom")
      .eq("route_id", routeId)
      .not("stop_id", "in", `(${quotedStopIds})`);
    if (deleteMappingsErr) {
      throw new Error(deleteMappingsErr.message);
    }
  }

  await updateInstagramCustomRouteMetadata(admin, routeId, {
    city,
    length_minutes: routeLengthMinutes,
    title: resolvedRouteTitle,
    narrator_default: "adult",
    narrator_guidance: null,
    narrator_voice: null,
    status: "ready",
    experience_kind: "mix",
    story_by: attribution.storyBy,
    story_by_url: attribution.storyByUrl,
    story_by_avatar_url: resolvedRouteAvatarUrl,
    story_by_source: attribution.storyBySource,
  });

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

async function processPublishCollectionJob(
  admin: SupabaseClient,
  job: InstagramImportJobRow,
  lockToken: string
) {
  const draftIds = getJobDraftIds(job);
  if (draftIds.length === 0) {
    throw new Error("Master publish did not include any draft IDs");
  }
  if (draftIds.length > INSTAGRAM_COLLECTION_MAX_STOPS) {
    throw new Error(`Select at most ${INSTAGRAM_COLLECTION_MAX_STOPS} stops.`);
  }

  const drafts = await loadDraftsByIds(admin, draftIds);
  await updateDrafts(admin, draftIds, {
    status: "publishing",
    error: null,
  });

  const { routeTitle, existingRouteId } = extractCollectionPublishOptionsFromJobMessage(job.message);

  const { jamId, routeId } = await publishDraftCollectionToRoute(
    admin,
    drafts,
    routeTitle,
    existingRouteId,
    async (progress, message) => {
      await updateJobWithLock(admin, job.id, lockToken, {
        progress,
        message,
      });
    }
  );

  await updateDrafts(admin, draftIds, {
    status: "published",
    published_jam_id: jamId,
    published_route_id: routeId,
    error: null,
  });

  await updateJobWithLock(admin, job.id, lockToken, {
    status: successJobStatusForPhase("publish_collection"),
    progress: 100,
    message: "Route published",
    error: null,
  });
}

async function failJob(
  admin: SupabaseClient,
  job: InstagramImportJobRow,
  lockToken: string,
  message: string
) {
  const draftIds = getJobDraftIds(job);
  const drafts = await loadDraftsByIds(admin, draftIds);
  for (const draft of drafts) {
    const hasPublishedRoute = Boolean(draft.published_jam_id && draft.published_route_id);
    const isPublishableDraft = isInstagramDraftPublishable(buildDraftContent(draft));
    const recoveredStatus =
      job.phase === "publish_collection"
        ? hasPublishedRoute
          ? "published"
          : isPublishableDraft
            ? "draft_ready"
            : nextInstagramDraftStatus(draft.status, "job_failed")
        : nextInstagramDraftStatus(draft.status, "job_failed");

    await updateDraft(admin, draft.id, {
      status: recoveredStatus,
      error:
        recoveredStatus === "failed"
          ? message
          : null,
    });
  }
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
    if (job.phase === "publish_collection") {
      await processPublishCollectionJob(admin, job, lockToken);
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
