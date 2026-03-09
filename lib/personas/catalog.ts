import { customNarratorPersonaPrompt } from "@/lib/personas/customNarrator";
import { historianPersonaPrompt } from "@/lib/personas/historian";
import { mainCharacterPersonaPrompt } from "@/lib/personas/mainCharacter";
import { ghostWhispererPersonaPrompt } from "@/lib/personas/ghostWhisperer";

export const personaCatalog = {
  adult: {
    prompt: historianPersonaPrompt,
    displayName: "AI Historian",
    description: "History, without boredom",
    avatarSrc: "/images/avatars/ai-historian.png",
    avatarAlt: "AI Historian avatar",
  },
  preteen: {
    prompt: mainCharacterPersonaPrompt,
    displayName: "AI Explorer",
    description: "Adventures made for curious kids.",
    avatarSrc: "/images/avatars/ai-main-character.png",
    avatarAlt: "AI Explore Mode avatar",
  },
  ghost: {
    prompt: ghostWhispererPersonaPrompt,
    displayName: "AI Ghost Whisperer",
    description: "Eerie folklore, grounded in history",
    avatarSrc: "/images/avatars/ai-ghost-whisper.png",
    avatarAlt: "AI Ghost Whisperer avatar",
  },
  custom: {
    prompt: customNarratorPersonaPrompt,
    displayName: "Custom Narrator",
    description: "A narrator tuned to your audience and interests.",
    avatarSrc: "/icons/stars.svg",
    avatarAlt: "Custom narrator icon",
  },
} as const;
