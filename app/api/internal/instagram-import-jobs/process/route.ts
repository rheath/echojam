import { NextResponse } from "next/server";
import { processQueuedInstagramImportJobs } from "@/lib/server/instagramImportWorker";

type Body = {
  limit?: number;
};

export async function POST(req: Request) {
  try {
    const token = (process.env.INSTAGRAM_IMPORT_WORKER_TOKEN || "").trim();
    const provided = (req.headers.get("x-instagram-import-worker-token") || "").trim();
    if (!token) {
      return NextResponse.json(
        { error: "INSTAGRAM_IMPORT_WORKER_TOKEN is not configured." },
        { status: 500 }
      );
    }
    if (!provided || provided !== token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as Body;
    const result = await processQueuedInstagramImportJobs(body.limit);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to process Instagram import jobs" },
      { status: 500 }
    );
  }
}
