import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRootUrl = pathToFileURL(path.resolve(import.meta.dirname, "..") + path.sep);
const serverOnlyStub = "data:text/javascript,export {}";
const EXTENSION_PATTERN = /\.(?:[cm]?js|jsx|ts|tsx|json)$/i;

export async function resolve(specifier, context, defaultResolve) {
  if (specifier === "server-only") {
    return {
      url: serverOnlyStub,
      shortCircuit: true,
    };
  }
  if (specifier.startsWith("@/")) {
    const target = specifier.slice(2);
    const withExtension = EXTENSION_PATTERN.test(target) ? target : `${target}.ts`;
    return defaultResolve(
      new URL(withExtension, repoRootUrl).href,
      context,
      defaultResolve
    );
  }
  return defaultResolve(specifier, context, defaultResolve);
}
