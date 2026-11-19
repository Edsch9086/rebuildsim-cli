{
  description = "REBUILDSIM headless bot CLI";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      perSystem =
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          node = pkgs.nodejs_22;
          rebuildsim-cli = pkgs.rustPlatform.buildRustPackage {
            pname = "rebuildsim-cli";
            version = "0.1.0";
            src = self;
            cargoLock.lockFile = ./Cargo.lock;
            nativeBuildInputs = [ pkgs.makeWrapper ];

            # The CLI launches engine/headless.cjs with `node`; make the
            # packaged binary work outside the dev shell too.
            postInstall = ''
              wrapProgram $out/bin/rebuildsim-cli \
                --prefix PATH : ${pkgs.lib.makeBinPath [ node ]}
            '';

            meta = {
              description = "Headless REBUILD Simulator bot CLI";
              mainProgram = "rebuildsim-cli";
              license = pkgs.lib.licenses.mit;
              platforms = pkgs.lib.platforms.unix;
            };
          };
        in
        {
          packages = {
            default = rebuildsim-cli;
            inherit rebuildsim-cli;
          };

          apps.default = {
            type = "app";
            program = "${rebuildsim-cli}/bin/rebuildsim-cli";
            meta.description = "Headless REBUILD Simulator bot CLI";
          };

          checks.default = rebuildsim-cli;

          devShells.default = pkgs.mkShell {
            packages = [
              pkgs.cargo
              pkgs.rustc
              pkgs.clippy
              pkgs.rustfmt
              pkgs.rust-analyzer
              node
              pkgs.jq
              pkgs.curl
              pkgs.git
            ];

            RUST_SRC_PATH = "${pkgs.rustPlatform.rustLibSrc}";

            shellHook = ''
              export RUST_BACKTRACE="''${RUST_BACKTRACE:-1}"
              echo "rebuildsim-cli dev shell — rust $(rustc --version 2>/dev/null | cut -d' ' -f2), node $(node --version)"
              if [ ! -f engine/cache/index.wasm ]; then
                echo "  engine assets are missing: run 'node engine/prepare.mjs'"
              fi
            '';
          };

          formatter = pkgs.nixfmt-rfc-style;
        };
    in
    {
      packages = forAllSystems (system: (perSystem system).packages);
      apps = forAllSystems (system: (perSystem system).apps);
      checks = forAllSystems (system: (perSystem system).checks);
      devShells = forAllSystems (system: (perSystem system).devShells);
      formatter = forAllSystems (system: (perSystem system).formatter);
    };
}
