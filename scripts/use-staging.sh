#!/usr/bin/env bash
# Gemelo POSIX de use-staging.ps1 — carga el entorno de STAGING en la shell actual
# y verifica que haya quedado COMPLETO antes de dejarte correr nada.
#
# POR QUÉ EXISTE
# --------------
# `.env.staging.local` trae DATABASE_URL de staging pero no las variables de
# Supabase Auth. Cargarlo a mano y correr un seed produce un entorno PARTIDO:
# dotenv completa las que faltan desde `.env.local`, así que Drizzle escribe en
# staging mientras el SDK de Auth lee de tu base local.
#
# Uso (el `source` importa: si lo ejecutás, las variables mueren con el proceso):
#   source ./scripts/use-staging.sh
#   pnpm repair:dni --allow-remote

ENV_FILE=".env.staging.local"

if [ ! -f "$ENV_FILE" ]; then
  echo "No encuentro $ENV_FILE en $(pwd)." >&2
  return 1 2>/dev/null || exit 1
fi

# set -a exporta todo lo que se asigne mientras está activo.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# Host + REF del proyecto. DIM (producción) y DIM-staging comparten el MISMO host
# de pooler, así que el host solo no distingue uno de otro.
host_only() {
  raw="$(printf '%s' "$1" | sed -E 's#^[a-z+]+://##')"
  h="$(printf '%s' "$raw" | sed -E 's#.*@##; s#[/?].*##')"
  # grep -o en vez de backreferences de sed: el ref son 20 caracteres [a-z0-9] y
  # buscarlos directo evita una expresion fragil de escapar.
  userinfo="${raw%%@*}"
  [ "$userinfo" = "$raw" ] && userinfo=""
  ref="$(printf '%s' "$userinfo" | grep -oE '[a-z0-9]{20}' | head -1)"
  if [ -z "$ref" ]; then
    ref="$(printf '%s' "$h" | grep -oE '[a-z0-9]{20}[.]supabase[.](co|com)' | grep -oE '^[a-z0-9]{20}' | head -1)"
  fi
  if [ -n "$ref" ]; then printf '%s (proyecto %s)' "$h" "$ref"; else printf '%s' "$h"; fi
}

DB_HOST="$(host_only "${DATABASE_URL:-}")"
SB_HOST="$(host_only "${NEXT_PUBLIC_SUPABASE_URL:-}")"
[ -z "$DB_HOST" ] && DB_HOST="(sin definir)"
[ -z "$SB_HOST" ] && SB_HOST="(sin definir)"

# Una URL sin definir no es "remota": es una variable que falta, y decir REMOTO
# ahí manda a buscar el problema equivocado.
kind_of() {
  case "$1" in
    "(sin definir)") printf '' ;;
    *127.0.0.1*|*localhost*) printf '(LOCAL)' ;;
    *) printf '(REMOTO)' ;;
  esac
}
DB_KIND="$(kind_of "$DB_HOST")"
SB_KIND="$(kind_of "$SB_HOST")"

echo
echo "  Base de datos  -> $DB_HOST  $DB_KIND"
echo "  Supabase Auth  -> $SB_HOST  $SB_KIND"
echo

MISSING=""
for v in DATABASE_URL NEXT_PUBLIC_SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY; do
  eval "val=\${$v:-}"
  [ -z "$val" ] && MISSING="$MISSING $v"
done

if [ -n "$MISSING" ]; then
  echo "INCOMPLETO. Falta en $ENV_FILE:" >&2
  for v in $MISSING; do echo "  - $v" >&2; done
  echo >&2
  echo "Podés correr scripts que SOLO escriben en la base (pnpm repair:dni)." >&2
  echo "NO corras los seeds: van a cortar por entorno partido." >&2
  return 1 2>/dev/null || exit 1
fi

if [ "$DB_KIND" != "$SB_KIND" ]; then
  echo "ENTORNO PARTIDO — no corras nada. Revisá $ENV_FILE." >&2
  return 1 2>/dev/null || exit 1
fi

if [ "$DB_KIND" = "(LOCAL)" ]; then
  echo "Entorno LOCAL cargado."
else
  echo "Entorno STAGING cargado y completo."
  echo "Acordate de --allow-remote en cada comando."
fi
echo
