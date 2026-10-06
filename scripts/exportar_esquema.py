#!/usr/bin/env python3
"""Guarda la estructura REAL de la base de datos de producción en database/schema_produccion.sql.

Cómo se usa (desde la carpeta del backend):
    python3 scripts/exportar_esquema.py

Pide tu PIN de supervisor en la terminal (no se ve al escribir). Solo LEE: usa la ruta
GET /api/diagnostico/esquema, que no cambia nada. El archivo queda listo para recrear la base
de datos o armar una copia de pruebas (usa CREATE TABLE IF NOT EXISTS)."""
import getpass, json, os, re, sys, datetime, urllib.request, urllib.error

B = os.environ.get("POS_API", "https://el-jardin-de-los-conejos.up.railway.app/api")
# Tablas que ya crean los modelos de Sequelize (el resto se había creado a mano)
DE_LOS_MODELOS = {"categories", "daily_summaries", "order_items", "orders", "payments", "products", "tables", "users"}

def llamar(metodo, ruta, cuerpo=None, token=None):
    req = urllib.request.Request(B + ruta, method=metodo, data=json.dumps(cuerpo).encode() if cuerpo is not None else None)
    req.add_header("Content-Type", "application/json")
    if token: req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=120) as r: return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try: return e.code, json.load(e)
        except Exception: return e.code, {}

rol = input("¿Entras como supervisor? [supervisor]: ").strip().lower() or "supervisor"
pin = getpass.getpass("PIN (no se ve al escribir): ")
c, r = llamar("POST", "/auth/login", {"role": rol, "pin": pin})
if not r.get("success"): sys.exit("No se pudo iniciar sesión: " + str(r.get("message")))
token = r["token"]
if r.get("user", {}).get("twoFactorEnabled") and not re.fullmatch(r"\d{6}", pin):
    c, v = llamar("POST", "/auth/2fa/verify-login", {"totpCode": input("Código de 2FA: ").strip()}, token)
    if not v.get("success"): sys.exit("2FA incorrecto")

c, d = llamar("GET", "/diagnostico/esquema", token=token)
if not d.get("success"):
    sys.exit(f"No se pudo leer el esquema (HTTP {c}): {d.get('message', 'revisa que el backend nuevo ya esté desplegado y que entres como supervisor')}")

destino = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "database", "schema_produccion.sql")
os.makedirs(os.path.dirname(destino), exist_ok=True)
fallaron = []
with open(destino, "w", encoding="utf-8") as f:
    f.write("-- Estructura de la base de datos de PRODUCCIÓN (solo estructura, sin datos).\n")
    f.write(f"-- Generado el {datetime.datetime.now():%Y-%m-%d %H:%M} desde la base '{d['base']}' (MySQL {d['version']}).\n")
    f.write("-- Para recrear la base: ejecutar este archivo completo. Usa CREATE TABLE IF NOT EXISTS.\n")
    f.write("-- Las marcadas «a mano» no las crea ningún modelo del proyecto: esta es la única copia de su estructura.\n\n")
    f.write("SET FOREIGN_KEY_CHECKS = 0;\n\n")
    for t in d["tablas"]:
        origen = "la crea un modelo de Sequelize" if t["tabla"] in DE_LOS_MODELOS else "creada a mano / por el código"
        f.write(f"-- {t['tabla']}  ({t['filas']} filas · {origen})\n")
        if not t.get("ddl"):
            fallaron.append(t["tabla"]); f.write(f"-- NO se pudo leer: {t.get('error')}\n\n"); continue
        ddl = re.sub(r"^CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ", t["ddl"])
        ddl = re.sub(r" AUTO_INCREMENT=\d+", "", ddl)
        f.write(ddl + ";\n\n")
    f.write("SET FOREIGN_KEY_CHECKS = 1;\n")

print(f"\nListo: {len(d['tablas'])} tablas guardadas en {destino}")
if fallaron: print("No se pudieron leer:", ", ".join(fallaron))
print("Ahora dile a Claude que lo revise y lo commitee.")
