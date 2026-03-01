"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

type RedirectToJamProps = {
  deepLinkPath: string;
};

export default function RedirectToJam({ deepLinkPath }: RedirectToJamProps) {
  const router = useRouter();

  useEffect(() => {
    router.replace(deepLinkPath);
  }, [router, deepLinkPath]);

  return null;
}
