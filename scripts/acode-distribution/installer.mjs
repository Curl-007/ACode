const packageDirName = "acode";

export function installScriptSource(baseUrl) {
  return `#!/usr/bin/env sh
set -eu

BASE_URL="\${ACODE_DIST_BASE_URL:-${baseUrl}}"
INSTALL_DIR="\${ACODE_DIST_HOME:-$HOME/.acode/runtime}"
BIN_DIR="\${ACODE_DIST_BIN_DIR:-$HOME/.local/bin}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "acode install requires $1" >&2
    exit 1
  fi
}

need_cmd node
need_cmd curl
need_cmd tar

LATEST_JSON="$(curl -fsSL "\${BASE_URL%/}/latest.json")"
VERSION="$(printf '%s' "$LATEST_JSON" | node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>process.stdout.write(JSON.parse(data).version))")"
TARBALL="$(printf '%s' "$LATEST_JSON" | node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>process.stdout.write(JSON.parse(data).tarball))")"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

ARCHIVE="$TMP_DIR/$TARBALL"
curl -fL "\${BASE_URL%/}/releases/$VERSION/$TARBALL" -o "$ARCHIVE"

# 落位前强校验（语义照抄 oh-my-pi scripts/install.sh：校验不通过绝不覆盖既有安装）。
# 哈希基准取 latest.json 的 sha256（构建时写入，发布前 verify_assets 作业还会对其
# 与 tarball 做一致性校验）；计算用 node:crypto 流式读取，规避 macOS 无 sha256sum、
# 部分 Linux 无 shasum 的平台差异——node 本就是本脚本的前置依赖。
EXPECTED_SHA256="$(printf '%s' "$LATEST_JSON" | node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>process.stdout.write(JSON.parse(data).sha256||''))")"
ACTUAL_SHA256="$(node -e "const c=require('node:crypto'),f=require('node:fs');const h=c.createHash('sha256');f.createReadStream(process.argv[1]).on('data',d=>h.update(d)).on('end',()=>process.stdout.write(h.digest('hex')))" "$ARCHIVE")"
if [ -z "$EXPECTED_SHA256" ]; then
  echo "acode install: latest.json missing sha256, refusing to install" >&2
  exit 1
fi
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  echo "acode install: sha256 mismatch (expected $EXPECTED_SHA256, got $ACTUAL_SHA256); refusing to install" >&2
  exit 1
fi
echo "acode install: sha256 verified ($ACTUAL_SHA256)"

mkdir -p "$INSTALL_DIR/releases" "$BIN_DIR"
TARGET="$INSTALL_DIR/releases/$VERSION"
rm -rf "$TARGET.new"
mkdir -p "$TARGET.new"
tar -xzf "$ARCHIVE" -C "$TARGET.new"
rm -rf "$TARGET"
mv "$TARGET.new/${packageDirName}" "$TARGET"
rm -rf "$TARGET.new"
ln -sfn "$TARGET" "$INSTALL_DIR/current"

cat > "$BIN_DIR/acode" <<SH
#!/usr/bin/env sh
exec node "$INSTALL_DIR/current/bin/acode.mjs" "\\$@"
SH
chmod +x "$BIN_DIR/acode"

echo "ACode $VERSION installed."
echo "Run: acode (TUI) or acode --web (Web)"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Note: $BIN_DIR is not in PATH." ;;
esac
`;
}
