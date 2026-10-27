const escape = (text: string) => text.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/** `**` spans directories, `*` and `?` stay inside one; a leading `**\/` also matches the root. */
export function globToRegExp(glob: string) {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else source += escape(c);
  }
  return new RegExp(`^${source}$`);
}

export const matchesAny = (path: string, globs: readonly string[]) => globs.some((glob) => globToRegExp(glob).test(path));
