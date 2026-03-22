import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { proxyGoogleImageUrl } from "@/lib/placesImages";
import {
  composeInstagramImportSourceText,
  toNullableTrimmed,
  type InstagramPlaceCandidate,
} from "@/lib/instagramImport";
import { getSupabaseAdminClient } from "@/lib/server/supabaseAdmin";
import {
  isTikTokDraftPublishable,
  normalizeTikTokUrl,
  resolveTikTokDraftScript,
  resolveTikTokDraftTitle,
  serializeTikTokMetrics,
  type TikTokDraftContent,
  type TikTokDraftResponse,
  type TikTokImportDraftStatus,
  type TikTokImportJobPhase,
  type TikTokImportJobResponse,
} from "@/lib/tiktokImport";

type TikTokImportDraftRow = {
  id: string;
  source_url: string;
  source_kind: "video";
  source_video_id: string | null;
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
  status: TikTokImportDraftStatus;
  warning: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

type TikTokImportJobRow = {
  id: string;
  draft_id: string;
  phase: TikTokImportJobPhase;
  status: "queued" | "processing" | "draft_ready" | "failed";
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
    displayName?: { text?: string };
    location?: { latitude?: number; longitude?: number };
    formattedAddress?: string;
  }>;
  error?: { message?: string };
};

const DRAFT_SELECT = `
  id,
  source_url,
  source_kind,
  source_video_id,
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
const YT_DLP_TIMEOUT_MS = 90_000;
const FFMPEG_TIMEOUT_MS = 45_000;
const JOB_STALE_MS = 10 * 60 * 1000;

function getAdmin(admin?: SupabaseClient) {
  return admin ?? getSupabaseAdminClient();
}

function getOpenAiApiKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required.");
  return apiKey;
}

function buildDraftContent(row: TikTokImportDraftRow): TikTokDraftContent {
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
  return {
    label,
    lat: Number(lat),
    lng: Number(lng),
    imageUrl: proxyGoogleImageUrl(imageUrl) || imageUrl,
    googlePlaceId,
    formattedAddress,
  };
}

function serializeTikTokJob(job: TikTokImportJobRow | null): TikTokImportJobResponse | null {
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

function serializeTikTokDraft(
  row: TikTokImportDraftRow,
  latestJob: TikTokImportJobRow | null
): TikTokDraftResponse {
  const finalScript = resolveTikTokDraftScript(buildDraftContent(row));
  const finalTitle = resolveTikTokDraftTitle(buildDraftContent(row));
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
      kind: "video",
      videoId: row.source_video_id,
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
      finalTitle,
      finalScript,
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
      publishReady: isTikTokDraftPublishable(buildDraftContent(row)),
    },
    metrics: serializeTikTokMetrics(extractedText, row.transcript_cleaned, finalScript),
    latestJob: serializeTikTokJob(latestJob),
  };
}

async function execFileAsync(file: string, args: string[], timeoutMs: number) {
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

async function downloadMedia(url: string, outputDir: string) {
  const outputTemplate = path.join(outputDir, "%(id)s.%(ext)s");
  await execFileAsync(
    process.env.YT_DLP_PATH || "yt-dlp",
    ["--no-playlist", "--restrict-filenames", "--output", outputTemplate, "--format", "mp4/best", url],
    YT_DLP_TIMEOUT_MS
  );
  const entries = await fs.readdir(outputDir);
  const mediaFile = entries
    .map((entry) => path.join(outputDir, entry))
    .find((entry) => /\.(mp4|m4a|webm|mov)$/i.test(entry));
  if (!mediaFile) throw new Error("yt-dlp did not produce a media file");
  return mediaFile;
}

async function dumpTikTokMetadata(url: string) {
  const { stdout } = await execFileAsync(
    process.env.YT_DLP_PATH || "yt-dlp",
    ["--dump-single-json", "--no-download", url],
    YT_DLP_TIMEOUT_MS
  );
  const payload = JSON.parse(stdout) as Record<string, unknown>;
  return {
    canonicalUrl:
      toNullableTrimmed(payload.webpage_url as string | undefined) ||
      toNullableTrimmed(url),
    videoId:
      toNullableTrimmed(payload.id as string | undefined) ||
      normalizeTikTokUrl(url)?.videoId ||
      null,
    ownerTitle:
      toNullableTrimmed(payload.uploader_id as string | undefined) ||
      toNullableTrimmed(payload.creator as string | undefined) ||
      toNullableTrimmed(payload.uploader as string | undefined),
    ownerUserId: toNullableTrimmed(payload.channel_id as string | undefined),
    caption:
      toNullableTrimmed(payload.description as string | undefined) ||
      toNullableTrimmed(payload.title as string | undefined),
    thumbnailUrl:
      toNullableTrimmed(payload.thumbnail as string | undefined) ||
      null,
  };
}

async function extractAudioTrack(inputPath: string, outputPath: string) {
  await execFileAsync(
    process.env.FFMPEG_PATH || "ffmpeg",
    ["-y", "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", outputPath],
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
  if (firstBrace >= 0 && lastBrace > firstBrace) return trimmed.slice(firstBrace, lastBrace + 1);
  throw new Error("JSON response was not found in model output");
}

async function cleanupImportedText(apiKey: string, importedText: string) {
  const systemPrompt = [
    "You clean transcript and caption text from short-form travel videos.",
    "Remove filler words, hashtags, sponsor callouts, and obvious transcription errors.",
    "Keep place names, neighborhood names, landmarks, and itinerary details intact.",
    "Return only cleaned prose.",
  ].join(" ");
  return await runChatCompletion(apiKey, systemPrompt, importedText);
}

async function convertCleanedTextToTourStop(apiKey: string, payload: { caption?: string | null; transcript?: string | null; cleanedText?: string | null; }) {
  const systemPrompt = [
    "Convert imported short-form video notes into one tour stop.",
    "Return strict JSON with keys: title, script, placeQuery, cityHint, countryHint, confidence.",
    "title: concise place title.",
    "script: 90-180 words of polished walking-tour narration.",
    "placeQuery: the best single Google Places query.",
    "cityHint and countryHint should be null when unknown.",
    "confidence must be a number between 0 and 1.",
  ].join(" ");
  const userPrompt = [
    payload.transcript ? `Transcript:\n${payload.transcript}` : null,
    payload.caption ? `Caption:\n${payload.caption}` : null,
    payload.cleanedText ? `Cleaned notes:\n${payload.cleanedText}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
  const response = await runChatCompletion(apiKey, systemPrompt, userPrompt);
  const parsed = JSON.parse(extractJsonObject(response || "{}")) as Partial<TourStopConversion>;
  return {
    title: toNullableTrimmed(parsed.title) || "Imported TikTok stop",
    script: toNullableTrimmed(parsed.script) || "",
    placeQuery: toNullableTrimmed(parsed.placeQuery) || "",
    cityHint: toNullableTrimmed(parsed.cityHint),
    countryHint: toNullableTrimmed(parsed.countryHint),
    confidence: Number.isFinite(parsed.confidence) ? Number(parsed.confidence) : 0.4,
  } satisfies TourStopConversion;
}

async function searchPlaces(query: string, cityHint: string | null, countryHint: string | null, limit: number) {
  const apiKey = (process.env.GOOGLE_PLACES_API_KEY || "").trim();
  if (!apiKey) return [] as InstagramPlaceCandidate[];
  const hint = [cityHint, countryHint].filter(Boolean).join(", ");
  const textQuery = hint ? `${query}, ${hint}` : query;
  const response = await fetch(GOOGLE_TEXT_SEARCH_NEW_ENDPOINT, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.location,places.formattedAddress",
    },
    body: JSON.stringify({
      textQuery,
      maxResultCount: limit,
    }),
  });
  if (!response.ok) return [] as InstagramPlaceCandidate[];
  const payload = (await response.json()) as GooglePlaceSearchResponse;
  return (payload.places ?? [])
    .map((place) =>
      makePlaceCandidate(
        toNullableTrimmed(place.displayName?.text) || null,
        Number(place.location?.latitude),
        Number(place.location?.longitude),
        null,
        toNullableTrimmed(place.id) || null,
        toNullableTrimmed(place.formattedAddress) || null
      )
    )
    .filter((place): place is InstagramPlaceCandidate => Boolean(place));
}

async function loadDraft(admin: SupabaseClient, draftId: string) {
  const { data, error } = await admin
    .from("tiktok_import_drafts")
    .select(DRAFT_SELECT)
    .eq("id", draftId)
    .single();
  if (error || !data) throw new Error(error?.message || "TikTok draft not found");
  return data as TikTokImportDraftRow;
}

async function loadLatestJobForDraft(admin: SupabaseClient, draftId: string) {
  const { data, error } = await admin
    .from("tiktok_import_jobs")
    .select(JOB_SELECT)
    .eq("draft_id", draftId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as TikTokImportJobRow | null) ?? null;
}

async function updateDraft(admin: SupabaseClient, draftId: string, patch: Record<string, unknown>) {
  const { error } = await admin.from("tiktok_import_drafts").update(patch).eq("id", draftId);
  if (error) throw new Error(error.message);
}

async function updateJobWithLock(
  admin: SupabaseClient,
  jobId: string,
  lockToken: string,
  patch: Partial<TikTokImportJobRow>
) {
  const { error } = await admin
    .from("tiktok_import_jobs")
    .update({
      ...patch,
      last_heartbeat_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("lock_token", lockToken);
  if (error) throw new Error(error.message);
}

export async function createTikTokImportJob(draftId: string, phase: TikTokImportJobPhase = "import", adminArg?: SupabaseClient) {
  const admin = getAdmin(adminArg);
  const { data, error } = await admin
    .from("tiktok_import_jobs")
    .insert({
      draft_id: draftId,
      phase,
      status: "queued",
      progress: 0,
      message: "Queued",
    })
    .select("id,draft_id,phase,status,progress,message,error,attempts,locked_at,last_heartbeat_at,lock_token,created_at,updated_at")
    .single();
  if (error || !data) throw new Error(error?.message || "Failed to create TikTok import job");
  return data as TikTokImportJobRow;
}

export async function getTikTokDraftResponseById(draftId: string, adminArg?: SupabaseClient) {
  const admin = getAdmin(adminArg);
  const [draft, latestJob] = await Promise.all([loadDraft(admin, draftId), loadLatestJobForDraft(admin, draftId)]);
  return serializeTikTokDraft(draft, latestJob);
}

export async function updateTikTokDraftById(
  draftId: string,
  patch: Partial<TikTokImportDraftRow>,
  adminArg?: SupabaseClient
) {
  const admin = getAdmin(adminArg);
  await updateDraft(admin, draftId, patch);
  return await getTikTokDraftResponseById(draftId, admin);
}

export async function searchTikTokImportPlaces(
  draftId: string,
  query: string | null | undefined,
  adminArg?: SupabaseClient
) {
  const admin = getAdmin(adminArg);
  const draft = await loadDraft(admin, draftId);
  const searchQuery =
    toNullableTrimmed(query) ||
    toNullableTrimmed(draft.place_query) ||
    resolveTikTokDraftTitle(buildDraftContent(draft));
  if (!searchQuery) return [] as InstagramPlaceCandidate[];
  return await searchPlaces(searchQuery, draft.place_city_hint, draft.place_country_hint, 6);
}

export async function getTikTokJobResponseById(jobId: string, adminArg?: SupabaseClient) {
  const admin = getAdmin(adminArg);
  const { data, error } = await admin
    .from("tiktok_import_jobs")
    .select(JOB_SELECT)
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return serializeTikTokJob((data as TikTokImportJobRow | null) ?? null);
}

async function claimNextJob(admin: SupabaseClient) {
  const staleBefore = new Date(Date.now() - JOB_STALE_MS).toISOString();
  const { data, error } = await admin
    .from("tiktok_import_jobs")
    .select(JOB_SELECT)
    .or(`status.eq.queued,and(status.eq.processing,last_heartbeat_at.lt.${staleBefore})`)
    .order("created_at", { ascending: true })
    .limit(10);
  if (error) throw new Error(error.message);

  for (const row of ((data ?? []) as TikTokImportJobRow[])) {
    const lockToken = randomUUID();
    const { data: claimed } = await admin
      .from("tiktok_import_jobs")
      .update({
        status: "processing",
        attempts: (row.attempts || 0) + 1,
        lock_token: lockToken,
        locked_at: new Date().toISOString(),
        last_heartbeat_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("updated_at", row.updated_at)
      .select(JOB_SELECT)
      .maybeSingle();
    if (claimed) return { job: claimed as TikTokImportJobRow, lockToken };
  }

  return null;
}

async function buildImportedTranscript(apiKey: string, normalizedUrl: string) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "echojam-tt-"));
  let cleanupWarning: string | null = null;
  try {
    const mediaPath = await downloadMedia(normalizedUrl, tempDir);
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

async function processImportJob(admin: SupabaseClient, job: TikTokImportJobRow, lockToken: string) {
  const draft = await loadDraft(admin, job.draft_id);
  const apiKey = getOpenAiApiKey();

  await updateDraft(admin, draft.id, {
    status: "importing",
    error: null,
  });

  await updateJobWithLock(admin, job.id, lockToken, {
    progress: 15,
    message: "Fetching TikTok metadata",
  });

  const metadata = await dumpTikTokMetadata(draft.source_url);

  await updateJobWithLock(admin, job.id, lockToken, {
    progress: 35,
    message: "Extracting audio and transcript",
  });

  const transcriptResult = await buildImportedTranscript(apiKey, metadata.canonicalUrl || draft.source_url);
  const transcript = transcriptResult.transcript;
  const importedText = composeInstagramImportSourceText(metadata.caption, transcript);
  if (!importedText) {
    throw new Error("No transcript or caption text was available for this TikTok video");
  }

  await updateJobWithLock(admin, job.id, lockToken, {
    progress: 55,
    message: "Cleaning imported text",
  });
  const cleanedText = await cleanupImportedText(apiKey, importedText);
  if (!cleanedText) throw new Error("Cleanup prompt returned empty text");

  await updateJobWithLock(admin, job.id, lockToken, {
    progress: 72,
    message: "Converting to tour draft",
  });
  const converted = await convertCleanedTextToTourStop(apiKey, {
    caption: metadata.caption,
    transcript,
    cleanedText,
  });
  const candidates = await searchPlaces(converted.placeQuery, converted.cityHint, converted.countryHint, 3);
  const topCandidate = candidates[0] ?? null;

  const warnings = [draft.warning, transcriptResult.warning, candidates.length === 0 ? "Location confirmation required." : null]
    .filter((value): value is string => Boolean(toNullableTrimmed(value)))
    .join(" ");

  await updateDraft(admin, draft.id, {
    source_url: metadata.canonicalUrl || draft.source_url,
    source_video_id: metadata.videoId,
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
    status: "draft_ready",
    warning: toNullableTrimmed(warnings),
    error: null,
  });

  await updateJobWithLock(admin, job.id, lockToken, {
    status: "draft_ready",
    progress: 100,
    message: "Draft ready",
    error: null,
  });
}

export async function processQueuedTikTokImportJobs(limit = 1, adminArg?: SupabaseClient) {
  const admin = getAdmin(adminArg);
  const processedJobs: string[] = [];
  for (let index = 0; index < limit; index += 1) {
    const claimed = await claimNextJob(admin);
    if (!claimed) break;
    const { job, lockToken } = claimed;
    try {
      await processImportJob(admin, job, lockToken);
    } catch (error) {
      await updateDraft(admin, job.draft_id, {
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown TikTok import failure",
      }).catch(() => undefined);
      await updateJobWithLock(admin, job.id, lockToken, {
        status: "failed",
        progress: 100,
        message: "Import failed",
        error: error instanceof Error ? error.message : "Unknown TikTok import failure",
      }).catch(() => undefined);
    }
    processedJobs.push(job.id);
  }
  return { processedJobs };
}
