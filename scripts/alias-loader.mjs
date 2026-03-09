import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRootUrl = pathToFileURL(path.resolve(import.meta.dirname, "..") + path.sep);

export async function resolve(specifier, context, defaultResolve) {
  if (specifier.startsWith("@/")) {
    const target = specifier.slice(2);
    const withExtension = /\.[a-z]+$/i.test(target) ? target : `${target}.ts`;
    return defaultResolve(
      new URL(withExtension, repoRootUrl).href,
      context,
      defaultResolve
    );
  }
  return defaultResolve(specifier, context, defaultResolve);
}
