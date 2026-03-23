import { notFound } from "next/navigation";
import { getJourneyOfferingBySlug } from "@/lib/server/journeyAccess";
import JourneyAccessClient from "./JourneyAccessClient";

export default async function JourneyOfferingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const offering = await getJourneyOfferingBySlug(slug);
  if (!offering) {
    notFound();
  }

  return <JourneyAccessClient slug={slug} initialTeaser={offering} />;
}
