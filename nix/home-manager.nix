self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.picopi;
  picopi = self.lib.${pkgs.stdenv.hostPlatform.system}.mkPicopi {
    inherit (cfg)
      extraSettings
      extraExtensions
      extraAgents
      extraEnv
      ;
    picopiConfig = cfg.config;
  };
in
{
  options.programs.picopi = {
    enable = lib.mkEnableOption "picopi (a configured pi coding agent)";

    config = lib.mkOption {
      type = lib.types.nullOr (lib.types.either lib.types.path lib.types.attrs);
      default = null;
      description = "Replacement config.json (path or attrs). Null uses the bundled default.";
    };

    extraSettings = lib.mkOption {
      type = lib.types.attrs;
      default = { };
      description = "Settings deep-merged into the bundled settings.json.";
    };

    extraExtensions = lib.mkOption {
      type = lib.types.listOf lib.types.path;
      default = [ ];
      description = "Additional extension files/dirs to load.";
    };

    extraAgents = lib.mkOption {
      type = lib.types.listOf lib.types.path;
      default = [ ];
      description = "Additional subagent .md definitions.";
    };

    extraEnv = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Environment variables baked into the picopi wrapper (e.g. PI_OFFLINE).";
      example = lib.literalExpression ''{ PI_SKIP_VERSION_CHECK = "1"; }'';
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ picopi ];
  };
}
