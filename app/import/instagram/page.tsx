import { notFound } from "next/navigation";
import InstagramImportClient from "./InstagramImportClient";

const INSTAGRAM_IMPORT_ENABLED = ["1", "true", "yes", "on"].includes(
  (process.env.NEXT_PUBLIC_ENABLE_INSTAGRAM_IMPORT || "").trim().toLowerCase()
);

export default function InstagramImportPage() {
  if (!INSTAGRAM_IMPORT_ENABLED) {
    notFound();
  }

  return <InstagramImportClient />;
}
