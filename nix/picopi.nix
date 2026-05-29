# Builds picopi as a wrapper around pi. ALL picopi source (the extension,
# prompts, themes, agents, AGENTS.md, default config) lives read-only in the
# Nix store and is handed to pi via CLI flags — nothing is copied into the
# config dir. The config dir (~/.config/picopi by default) holds ONLY
# user-owned, writable state: config.json, settings.json, models.json,
# auth.json, sessions/, npm/. The user supplies model API keys (env/auth).
{
  pkgs,
  piPkg, # pi coding-agent package from pi.nix
  src, # picopi repo root
  extraSettings ? { }, # deep-merged into the seeded settings.json default
  picopiConfig ? null, # path/attrs replacing config.json (null = bundled)
  extraExtensions ? [ ], # extra extension dirs/files (passed as -e flags)
  extraAgents ? [ ], # extra agent .md files (merged into the agents dir)
  extraEnv ? { }, # env vars baked into the wrapper
}:

let
  inherit (pkgs) lib;

  # Seeded settings.json: the repo default deep-merged with extraSettings. These
  # are USER PREFERENCES ONLY (theme name, thinking level, compaction, ...).
  # Crucially, NO resource wiring (extensions/prompts/themes paths) lives here,
  # so a once-seeded settings.json can never go stale against a new build.
  settings = lib.recursiveUpdate (lib.importJSON (src + "/agent/settings.json")) extraSettings;

  # A flake may bake a custom picopi config; otherwise the user's config wins.
  bakedConfig = picopiConfig != null;
  configFile =
    if !bakedConfig then
      src + "/agent/config.json"
    else if builtins.isAttrs picopiConfig then
      pkgs.writeText "config.json" (builtins.toJSON picopiConfig)
    else
      picopiConfig;

  # The read-only resource tree in the store. Mirrors the repo layout (src/ and
  # agent/{prompts,themes,agents,AGENTS.md,config.json}) so the extension's
  # repo-relative fallbacks (here/../agent/...) resolve agents and the default
  # config without any settings wiring. Only built to allow extraAgents and a
  # baked config to be folded in; otherwise it is just a copy of the repo.
  resources = pkgs.runCommand "picopi-resources" { } ''
    mkdir -p $out
    cp -r ${src + "/src"} $out/src
    cp -r ${src + "/agent"} $out/agent
    chmod -R u+w $out
    cp ${configFile} $out/agent/config.json
    ${lib.concatMapStringsSep "\n" (a: "cp ${a} $out/agent/agents/") extraAgents}
  '';

  # CLI flags that point pi at the store resources. These are ADDITIVE: project
  # AGENTS.md, .pi/extensions, etc. are still discovered normally.
  resourceFlags = lib.escapeShellArgs (
    [
      "--extension"
      "${resources}/src"
    ]
    ++ lib.concatMap (e: [
      "--extension"
      (toString e)
    ]) extraExtensions
    ++ [
      "--prompt-template"
      "${resources}/agent/prompts"
      "--theme"
      "${resources}/agent/themes"
      "--append-system-prompt"
      "${resources}/agent/AGENTS.md"
    ]
  );

  settingsFile = pkgs.writeText "settings.json" (builtins.toJSON settings);
in
pkgs.writeShellScriptBin "picopi" ''
  set -euo pipefail

  # Auto-launch tmux if not already inside one.
  if [ -z "''${TMUX:-}" ]; then
    export PATH="${pkgs.tmux}/bin:$PATH"
    exec tmux new-session -s picopi -- "$0" "$@"
  fi

  # The config dir holds ONLY user-owned state. Defaults to ~/.config/picopi;
  # relocate with $PICOPI_HOME. picopi source is never copied here.
  dir="''${PICOPI_HOME:-''${XDG_CONFIG_HOME:-$HOME/.config}/picopi}"
  mkdir -p "$dir"

  # Seed user-owned config once (never clobber).
  [ -e "$dir/settings.json" ] || { cp ${settingsFile} "$dir/settings.json"; chmod +w "$dir/settings.json"; }
  ${lib.optionalString (
    !bakedConfig
  ) ''[ -e "$dir/config.json" ] || { cp ${resources}/agent/config.json "$dir/config.json"; chmod +w "$dir/config.json"; }''}
  [ -e "$dir/models.json" ] || printf '{\n  "providers": {}\n}\n' > "$dir/models.json"

  # tmux for subagent pane visibility
  export PATH="${pkgs.tmux}/bin:$PATH"

  export PI_CODING_AGENT_DIR="$dir"
  ${lib.optionalString bakedConfig ''export PICOPI_CONFIG="${resources}/agent/config.json"''}
  ${lib.concatStringsSep "\n  " (
    lib.mapAttrsToList (n: v: "export ${n}=${lib.escapeShellArg v}") extraEnv
  )}
  exec ${lib.getExe piPkg} ${resourceFlags} "$@"
''
