{
  description = "pty-relay — remote access to pty sessions over an end-to-end encrypted WebSocket tunnel";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    pty.url = "github:compoundingtech/pty";
    pty.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      pty,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };

        # Node runtime for both the derivation's npm steps and the bin shim,
        # so a build and a run can never disagree on the interpreter.
        nodejs = pkgs.nodejs_24;

        # Unpublished sibling packages, resolved from their own flakes and
        # linked into node_modules at install time. npm records
        # `@compoundingtech/pty` as `file:../pty`, which is a dangling link
        # inside the sandbox; these store paths are what actually resolve.
        # TODO(rust): the Rust rewrite links this natively — drop the map.
        siblingPackages = {
          "@compoundingtech/pty" = "${pty.packages.${system}.default}/lib/pty";
        };

        linkSiblings = pkgs.lib.concatStringsSep "\n" (
          pkgs.lib.mapAttrsToList (name: path: ''
            mkdir -p "$out/lib/pty-relay/node_modules/${builtins.dirOf name}"
            rm -rf "$out/lib/pty-relay/node_modules/${name}"
            ln -s ${path} "$out/lib/pty-relay/node_modules/${name}"
          '') siblingPackages
        );

        # Single source of truth: package.json. Build identity beyond the
        # semver (commit rev, build date) is the org's shared build-identity
        # contract, not something this flake invents.
        version = (builtins.fromJSON (builtins.readFile ./package.json)).version;

        pty-relay = pkgs.buildNpmPackage {
          pname = "pty-relay";
          inherit version nodejs;

          src = self;

          # TODO(rust): cargo's lockfile is content-addressed; this vendoring
          # hash disappears with the npm dependency tree.
          # Regenerate with: nix run nixpkgs#prefetch-npm-deps -- package-lock.json
          npmDepsHash = "sha256-wDKiIRJivnTFd0dXCdKw+GoLJA6T53a/5sDCsbxvkUU=";

          # pty-relay ships as raw TypeScript executed by Node with native
          # type stripping — no compile step. Only the browser bundle has one,
          # and the daemon/CLI don't need it.
          dontNpmBuild = true;

          nativeBuildInputs = [ pkgs.installShellFiles ];

          # Installed outside node_modules so Node's type-stripping works on
          # src/cli.ts (Node refuses to strip types inside node_modules).
          installPhase = ''
            runHook preInstall

            mkdir -p $out/lib/pty-relay
            cp -r . $out/lib/pty-relay

            # TODO(rust): sibling linking is an npm-workspace workaround.
            ${linkSiblings}

            # TODO(rust): a compiled binary needs no interpreter shim.
            mkdir -p $out/bin
            cat > $out/bin/pty-relay <<EOF
            #!${pkgs.runtimeShell}
            exec ${nodejs}/bin/node --experimental-strip-types \\
              $out/lib/pty-relay/src/cli.ts "\$@"
            EOF
            chmod +x $out/bin/pty-relay

            # Generate completions from the binary we just built, so they can
            # never lag the shipped command surface.
            installShellCompletion --cmd pty-relay \
              --bash <($out/bin/pty-relay completions bash) \
              --zsh <($out/bin/pty-relay completions zsh) \
              --fish <($out/bin/pty-relay completions fish)

            runHook postInstall
          '';

          meta = {
            description = "Remote access to pty sessions over an end-to-end encrypted WebSocket tunnel";
            homepage = "https://github.com/compoundingtech/pty-relay";
            license = pkgs.lib.licenses.mit;
            mainProgram = "pty-relay";
          };
        };
      in
      {
        packages = {
          inherit pty-relay;
          default = pty-relay;
        };

        checks = {
          # The repo's own `tsc --noEmit`. It only passes once
          # @compoundingtech/pty resolves, which is exactly what the built
          # output provides — so run it against that rather than the raw src.
          typecheck = pkgs.runCommand "pty-relay-typecheck" { } ''
            export HOME=$(mktemp -d)
            cp -r ${pty-relay}/lib/pty-relay tree
            chmod -R u+w tree
            cd tree
            ${nodejs}/bin/node node_modules/typescript/bin/tsc --noEmit
            touch $out
          '';

          # NOTE: the vitest suite is deliberately NOT a check. It runs
          # green against this same built tree outside the sandbox, but under
          # the nix sandbox test/daemon-runtime.test.ts hangs indefinitely
          # (0/14, blocking session-list-view and terminal); the other 69/72
          # files pass. Gating `npm test` needs that file made sandbox-safe
          # first, so CI covers typecheck + the CLI smoke checks only.

          help = pkgs.runCommand "pty-relay-help" { } ''
            export HOME=$(mktemp -d)
            ${pty-relay}/bin/pty-relay --help > /dev/null
            touch $out
          '';

          completions = pkgs.runCommand "pty-relay-completions" { } ''
            export HOME=$(mktemp -d)
            for shell in bash zsh fish; do
              ${pty-relay}/bin/pty-relay completions $shell > script
              test -s script || { echo "empty $shell completions"; exit 1; }
            done
            touch $out
          '';
        };

        devShells.default = pkgs.mkShell {
          packages = [
            nodejs
            pty.packages.${system}.default
          ];
        };
      }
    );
}
