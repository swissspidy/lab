# Questions

Blockers not covered by the brief's open questions. Each one records the
conservative choice the lab took meanwhile.

1. **Conventions source.** The brief says to follow web-ai-evals. That repo
   is not available to this session. The lab follows Graft, Sandburg and
   Assay instead: npm workspaces, TypeScript run directly by Node,
   `node --test`, oxlint, Apache-2.0. Revisit when web-ai-evals is shared.
2. **Node version.** The siblings pin Node 24 (`.nvmrc`). The lab pins 24 too,
   but runs on 22.18 or later, since it needs only type stripping.
3. **Sandburg's role.** Sandburg runs dev servers inside its own browser and
   hands out no URL, so it does not fit `Sandbox.start()` as is. Two options:
   (a) add a "serve a built directory and return its URL" mode to Sandburg;
   (b) treat Sandburg as a Verify backend instead (its checks run where it
   serves). Meanwhile the lab uses its built-in sandbox. Which do you want?
4. **Graft spec schema.** Graft's spec schema is closed and host-specific.
   Should Graft gain a `website` host (with `touches` as its scope), or
   should the lab keep its own JSON schema and only borrow Graft's Markdown
   layout? Meanwhile the lab keeps its own schema.
