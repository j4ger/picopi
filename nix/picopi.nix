# Builds a contained pi "agent directory" (everything in the Nix store) and
# returns a wrapper package that runs pi against a writable copy of it via
# PI_CODING_AGENT_DIR. The user only supplies model API keys (env).
{
  pkgs,
  piPkg, # pi coding-agent package from pi.nix
  src, # picopi repo root
  extraSettings ? { }, # deep-merged into settings.json
  picopiConfig ? null, # path/attrs replacing config.json (null = bundled)
  extraExtensions ? [ ], # extra extension dirs/files
  extraAgents ? [ ], # extra agent .md files
  extraEnv ? { }, # env vars baked into the wrapper
}:

let
  inherit (pkgs) lib;

  # settings.json: bundled defaults <- extraSettings <- fixed resource paths.
  # All functionality ships as one self-contained extension, so no packages are
  # fetched: the build is fast and fully offline/reproducible.
  settings =
    lib.recursiveUpdate (lib.recursiveUpdate (lib.importJSON (src + "/agent/settings.json")) extraSettings)
      {
        packages = [ ];
        extensions = [ "src" ] ++ map toString extraExtensions;
        skills = [ ];
        prompts = [ "prompts" ];
        themes = [ "themes" ];
      };

  # A flake may bake a custom config; otherwise the user's config.json wins.
  bakedConfig = picopiConfig != null;
  configJson =
    if !bakedConfig then
      src + "/agent/config.json"
    else if builtins.isAttrs picopiConfig then
      pkgs.writeText "config.json" (builtins.toJSON picopiConfig)
    else
      picopiConfig;

  # The store template for the agent dir: the repo's agent/ tree plus the merged
  # settings.json and the src/ extension. config.json/settings.json are the
  # seeded defaults; the wrapper copies them into the live dir only if absent.
  agentDir = pkgs.runCommand "picopi-agent-dir" { } ''
    cp -r ${src + "/agent"} $out
    chmod -R u+w $out
    cp ${pkgs.writeText "settings.json" (builtins.toJSON settings)} $out/settings.json
    cp ${configJson} $out/config.json
    cp -r ${src + "/src"} $out/src
    ${lib.concatMapStringsSep "\n" (a: "cp ${a} $out/agents/") extraAgents}
    # pi resolves the extension's peer deps (@earendil-works/*, typebox) via the
    # NODE_PATH its own wrapper sets, so no node_modules is needed here.
  '';

  # Picopi-owned resources, refreshed from the store on every version change.
  # User-owned files (config.json, settings.json, models.json, auth.json,
  # sessions/, npm/) are seeded once and then never touched.
  shipped =
    [
      "AGENTS.md"
      "themes"
      "agents"
      "prompts"
      "src"
    ]
    # A baked config is flake-controlled, so refresh it instead of seeding once.
    ++ lib.optional bakedConfig "config.json";
  seeded = [ "settings.json" ] ++ lib.optional (!bakedConfig) "config.json";

in
pkgs.writeShellScriptBin "picopi" ''
  set -euo pipefail
  # The agent dir IS the config dir. Defaults to ~/.config/picopi; relocate with
  # $PICOPI_HOME. Picopi resources refresh on version change; user files persist.
  dir="''${PICOPI_HOME:-''${XDG_CONFIG_HOME:-$HOME/.config}/picopi}"
  mkdir -p "$dir"
  # Seed user-owned config once (never clobber).
  for f in ${lib.concatStringsSep " " seeded}; do
    [ -e "$dir/$f" ] || cp "${agentDir}/$f" "$dir/$f"
  done
  [ -e "$dir/models.json" ] || printf '{\n  "providers": {}\n}\n' > "$dir/models.json"
  # Refresh picopi resources on version change.
  if [ "$(cat "$dir/.stamp" 2>/dev/null || true)" != "${agentDir}" ]; then
    for f in ${lib.concatStringsSep " " shipped}; do
      rm -rf "$dir/$f"
      cp -rL "${agentDir}/$f" "$dir/$f"
    done
    chmod -R u+w "$dir"
    echo "${agentDir}" > "$dir/.stamp"
  fi
  export PI_CODING_AGENT_DIR="$dir"
  ${lib.optionalString bakedConfig ''export PICOPI_CONFIG="$dir/config.json"''}
  ${lib.concatStringsSep "\n  " (
    lib.mapAttrsToList (n: v: "export ${n}=${lib.escapeShellArg v}") extraEnv
  )}
  exec ${lib.getExe piPkg} "$@"
''
