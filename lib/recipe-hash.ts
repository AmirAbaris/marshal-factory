import { createHash } from "node:crypto";
import { canonicalRecipe, type Recipe } from "./recipe";

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Equal for recipes that mean the same, whatever their key order. */
export const recipeHash = (recipe: Recipe) => sha256(canonicalRecipe(recipe));
