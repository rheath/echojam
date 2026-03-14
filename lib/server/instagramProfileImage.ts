import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  extractInstagramUsernameFromProfileUrl,
  parseInstagramProfileImageUrlFromHtml,
  toNullableTrimmed,
} from "@/lib/instagramImport";

const execFileAsync = promisify(execFile);

const INSTAGRAM_PROFILE_FETCH_TIMEOUT_MS = 4_000;
const INSTAGRAM_FETCH_USER_AGENTS = [
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "Twitterbot/1.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
];

function parseInstagramProfileImageUrlFromApiPayload(payloadText: string) {
  try {
    const payload = JSON.parse(payloadText) as {
      data?: { user?: { profile_pic_url_hd?: string | null; profile_pic_url?: string | null } };
    };
    return (
      toNullableTrimmed(payload.data?.user?.profile_pic_url_hd) ||
      toNullableTrimmed(payload.data?.user?.profile_pic_url)
    );
  } catch {
    return null;
  }
}

async function fetchInstagramProfileImageViaFetch(username: string) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), INSTAGRAM_PROFILE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
      {
        method: "GET",
        headers: {
          "User-Agent": INSTAGRAM_FETCH_USER_AGENTS[2],
          "x-ig-app-id": "936619743392459",
          "x-asbd-id": "129477",
          Accept: "application/json",
        },
        cache: "no-store",
        signal: controller.signal,
      }
    );
    if (!response.ok) return null;
    return parseInstagramProfileImageUrlFromApiPayload(await response.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchInstagramProfileImageViaCurl(username: string) {
  try {
    const { stdout } = await execFileAsync(
      "curl",
      [
        "-sSL",
        "--max-time",
        String(Math.ceil(INSTAGRAM_PROFILE_FETCH_TIMEOUT_MS / 1000)),
        "-H",
        `User-Agent: ${INSTAGRAM_FETCH_USER_AGENTS[2]}`,
        "-H",
        "x-ig-app-id: 936619743392459",
        "-H",
        "x-asbd-id: 129477",
        "-H",
        "Accept: application/json",
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
      ],
      { maxBuffer: 1024 * 1024 }
    );
    return parseInstagramProfileImageUrlFromApiPayload(stdout);
  } catch {
    return null;
  }
}

async function fetchInstagramProfilePageHtmlViaCurl(profileUrl: string) {
  for (const userAgent of INSTAGRAM_FETCH_USER_AGENTS) {
    try {
      const { stdout } = await execFileAsync(
        "curl",
        [
          "-sSL",
          "--max-time",
          String(Math.ceil(INSTAGRAM_PROFILE_FETCH_TIMEOUT_MS / 1000)),
          "-H",
          `User-Agent: ${userAgent}`,
          "-H",
          "Accept: text/html,application/xhtml+xml",
          "-H",
          "Accept-Language: en-US,en;q=0.9",
          profileUrl,
        ],
        { maxBuffer: 2 * 1024 * 1024 }
      );
      const imageUrl = parseInstagramProfileImageUrlFromHtml(stdout);
      if (imageUrl) return imageUrl;
    } catch {
      continue;
    }
  }

  return null;
}

export async function fetchInstagramProfileImageUrl(profileUrl: string) {
  const username = extractInstagramUsernameFromProfileUrl(profileUrl);
  if (username) {
    const apiImage =
      (await fetchInstagramProfileImageViaFetch(username)) ||
      (await fetchInstagramProfileImageViaCurl(username));
    if (apiImage) return apiImage;
  }

  for (const userAgent of INSTAGRAM_FETCH_USER_AGENTS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), INSTAGRAM_PROFILE_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(profileUrl, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": userAgent,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
        cache: "no-store",
      });
      if (!response.ok) continue;
      const imageUrl = parseInstagramProfileImageUrlFromHtml(await response.text());
      if (imageUrl) return imageUrl;
    } catch {
      continue;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return fetchInstagramProfilePageHtmlViaCurl(profileUrl);
}
