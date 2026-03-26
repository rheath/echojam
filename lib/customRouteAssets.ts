import { toNullableAudioUrl, toNullableTrimmed } from "@/lib/mixGeneration";

export type CustomRouteAssetFields = {
  script_adult?: string | null;
  script_preteen?: string | null;
  script_ghost?: string | null;
  script_custom?: string | null;
  audio_url_adult?: string | null;
  audio_url_preteen?: string | null;
  audio_url_ghost?: string | null;
  audio_url_custom?: string | null;
};

export function mergeCustomRouteStopAssets(args: {
  routeStop: CustomRouteAssetFields;
  canonical?: CustomRouteAssetFields | null;
}) {
  const routeScriptAdult = toNullableTrimmed(args.routeStop.script_adult);
  const routeScriptPreteen = toNullableTrimmed(args.routeStop.script_preteen);
  const routeScriptGhost = toNullableTrimmed(args.routeStop.script_ghost);
  const routeScriptCustom = toNullableTrimmed(args.routeStop.script_custom);
  const routeAudioAdult = toNullableAudioUrl(args.routeStop.audio_url_adult);
  const routeAudioPreteen = toNullableAudioUrl(args.routeStop.audio_url_preteen);
  const routeAudioGhost = toNullableAudioUrl(args.routeStop.audio_url_ghost);
  const routeAudioCustom = toNullableAudioUrl(args.routeStop.audio_url_custom);

  return {
    script_adult:
      routeScriptAdult ?? toNullableTrimmed(args.canonical?.script_adult),
    script_preteen:
      routeScriptPreteen ?? toNullableTrimmed(args.canonical?.script_preteen),
    script_ghost:
      routeScriptGhost ?? toNullableTrimmed(args.canonical?.script_ghost),
    script_custom: routeScriptCustom,
    audio_url_adult:
      routeAudioAdult ?? toNullableAudioUrl(args.canonical?.audio_url_adult),
    audio_url_preteen:
      routeAudioPreteen ?? toNullableAudioUrl(args.canonical?.audio_url_preteen),
    audio_url_ghost:
      routeAudioGhost ?? toNullableAudioUrl(args.canonical?.audio_url_ghost),
    audio_url_custom: routeAudioCustom,
  };
}
