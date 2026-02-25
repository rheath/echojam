import { historianPersonaPrompt } from "@/lib/personas/historian";
import { mainCharacterPersonaPrompt } from "@/lib/personas/mainCharacter";

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
    displayName: "AI Main Character",
    description: "Story-led and playful",
    avatarSrc: "/images/avatars/ai-main-character.png",
    avatarAlt: "AI Main Character avatar",
  },
} as const;
