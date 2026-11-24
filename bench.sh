#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

REQUIRED_NODE="22.20.0"
CURRENT_NODE="$(node -v | sed 's/^v//')"

if [ "$(printf '%s\n' "$REQUIRED_NODE" "$CURRENT_NODE" | sort -V | head -n1)" != "$REQUIRED_NODE" ]; then
  echo "❌ Требуется Node.js >= v${REQUIRED_NODE} (текущая версия: v${CURRENT_NODE})"
  exit 1
fi

USE_LOCAL=false
FORCE_INSTALL=false
UPDATE_LATEST=false

for arg in "$@"; do
  case "$arg" in
    --local) USE_LOCAL=true ;;
    --install) FORCE_INSTALL=true ;;
    --update) UPDATE_LATEST=true ;;
  esac
done

START_TS=$(date +%s)
CACHE_DIR="$HOME/.cache/mol-collider/node_modules"

echo "======================================================================"
echo "🧠 Запуск стенда reactive-memory-benchmark (Node.js v${CURRENT_NODE})"
echo "======================================================================"

PACKAGES=(
  "@angular/core"
  "@pravosleva/reactive-engine"
  "@preact/signals-core"
  "@reatom/core"
  "@resvg/resvg-js"
  "@solidjs/signals"
  "@vue/reactivity"
  "@vue/shared"
  "alien-signals"
  "effector"
  "mobx"
  "mol_wire_lib"
)

save_to_local_cache() {
  mkdir -p "$CACHE_DIR/@pravosleva" "$CACHE_DIR/@solidjs" "$CACHE_DIR/@reatom" "$CACHE_DIR/@vue" "$CACHE_DIR/@angular" "$CACHE_DIR/@preact" "$CACHE_DIR/@resvg"
  for pkg in "${PACKAGES[@]}"; do
    if [ -d "node_modules/$pkg" ] && [ ! -L "node_modules/$pkg" ]; then
      rm -rf "$CACHE_DIR/$pkg"
      cp -r "node_modules/$pkg" "$CACHE_DIR/$pkg"
    fi
  done
}

restore_offline() {
  echo "⚠️  Сетевой реестр npm недоступен — восстанавливаем из локального кэша..."
  mkdir -p node_modules/@pravosleva node_modules/@solidjs node_modules/@reatom node_modules/@vue node_modules/@angular node_modules/@preact node_modules/@resvg

  for pkg in "${PACKAGES[@]}"; do
    if [ -e "node_modules/$pkg" ]; then
      continue
    fi

    if [ "$pkg" = "@pravosleva/reactive-engine" ] && [ -d "$HOME/projects/reactive-engine/dist" ]; then
      ln -s "$HOME/projects/reactive-engine" "node_modules/$pkg"
      echo "   ✔ $pkg -> $HOME/projects/reactive-engine"
      continue
    fi

    if [ -d "$CACHE_DIR/$pkg" ]; then
      cp -r "$CACHE_DIR/$pkg" "node_modules/$pkg"
      echo "   ✔ $pkg -> кэш (~/.cache/mol-collider)"
      continue
    fi

    found=$(find "$HOME/projects" -maxdepth 4 -type d -path "*/node_modules/$pkg" ! -path "$PROJECT_DIR/*" 2>/dev/null | head -n 1 || true)
    if [ -n "$found" ]; then
      ln -s "$found" "node_modules/$pkg"
      echo "   ✔ $pkg -> $found"
    fi
  done
}

if [ "$UPDATE_LATEST" = true ]; then
  echo "🔄 [1/4] Обнуление node_modules и загрузка самых свежих версий (@latest)..."
  rm -rf node_modules package-lock.json
  LATEST_SPECS=()
  for pkg in "${PACKAGES[@]}"; do
    if [ "$pkg" != "@vue/shared" ]; then
      LATEST_SPECS+=("${pkg}@latest")
    fi
  done

  if npm install "${LATEST_SPECS[@]}" --no-audit --no-fund 2>/dev/null; then
    save_to_local_cache
    echo "   ✔ Все пакеты обновлены до @latest и сохранены в локальный кэш"
  else
    restore_offline
  fi
elif [ ! -d "node_modules" ] || [ "$FORCE_INSTALL" = true ]; then
  echo "📦 [1/4] Обнуление и установка зависимостей из package.json..."
  rm -rf node_modules
  if npm install --prefer-offline --no-audit --no-fund 2>/dev/null; then
    save_to_local_cache
  else
    restore_offline
  fi
else
  echo "📦 [1/4] Зависимости в node_modules уже готовы"
fi

LOCAL_ENGINE_DIR="$HOME/projects/reactive-engine"
if [ "$USE_LOCAL" = true ] && [ -d "$LOCAL_ENGINE_DIR/dist" ]; then
  echo "🔗 [2/4] Подключение локальной сборки @pravosleva/reactive-engine из $LOCAL_ENGINE_DIR..."
  mkdir -p node_modules/@pravosleva
  rm -rf node_modules/@pravosleva/reactive-engine
  ln -s "$LOCAL_ENGINE_DIR" node_modules/@pravosleva/reactive-engine
elif [ "$USE_LOCAL" = true ]; then
  echo "⚠️  [2/4] Локальная сборка $LOCAL_ENGINE_DIR/dist не найдена — используем пакет из node_modules"
else
  echo "🔗 [2/4] Используются пакеты из node_modules (для локальной сборки: bash bench.sh --local)"
fi

echo "🧪 [3/4] Прогрев V8 JIT и замер памяти в изолированных процессах..."
node --expose-gc "$PROJECT_DIR/run.mjs"

echo "🖼️  [4/4] Генерация SVG, PNG (2x Retina) и обновление README.md..."
node "$PROJECT_DIR/generate-svg.mjs"
node "$PROJECT_DIR/generate-png.mjs"
node "$PROJECT_DIR/update-readme.mjs"

for artifact in "results/last-benchmark.json" "results/last-benchmark.svg" "results/last-benchmark.png" "README.md"; do
  if [ ! -s "$PROJECT_DIR/$artifact" ]; then
    echo "❌ Ошибка: артефакт $artifact не создан или пуст!"
    exit 1
  fi
done

if command -v file >/dev/null 2>&1; then
  PNG_INFO=$(file -b "$PROJECT_DIR/results/last-benchmark.png")
  echo "🔍 Проверка PNG: $PNG_INFO"
fi

END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))

echo "======================================================================"
echo "✅ Готово за ${ELAPSED} сек. Артефакты сохранены в ./results/ и ./README.md"
echo "======================================================================"

exit 0
