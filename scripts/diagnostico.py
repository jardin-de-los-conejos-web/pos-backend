#!/usr/bin/env python3
"""Uso (desde la carpeta del backend):  python3 scripts/diagnostico.py

Revisa que el servidor y la base de datos respondan bien en TODAS las rutas que usa la app (solo lee, no cambia nada)
y busca datos raros (cobros que no cuadran, órdenes abiertas viejas, inventario en cero...).
El PIN se escribe aquí en tu terminal (no se ve) y solo se manda al servidor."""
import getpass, json, re, sys, datetime, urllib.request, urllib.error

import os
B = os.environ.get("POS_API", "https://el-jardin-de-los-conejos.up.railway.app/api")
hoy = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=6)).strftime("%Y-%m-%d")

def llamar(metodo, ruta, cuerpo=None, token=None):
    req = urllib.request.Request(B + ruta, method=metodo, data=json.dumps(cuerpo).encode() if cuerpo is not None else None)
    req.add_header("Content-Type", "application/json")
    if token: req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=40) as r: return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try: return e.code, json.load(e)
        except Exception: return e.code, {}
    except Exception as e:
        return 0, {"message": str(e)}

rol = input("¿Entras como supervisor o empleado? [supervisor]: ").strip().lower() or "supervisor"
pin = getpass.getpass("PIN (no se ve al escribir): ")
c, r = llamar("POST", "/auth/login", {"role": rol, "pin": pin})
if not r.get("success"): sys.exit("No se pudo iniciar sesión: " + str(r.get("message")))
tk = r["token"]
if r.get("user", {}).get("twoFactorEnabled") and not re.fullmatch(r"\d{6}", pin):
    c, v = llamar("POST", "/auth/2fa/verify-login", {"totpCode": input("Código de 2FA: ").strip()}, tk)
    if not v.get("success"): sys.exit("2FA incorrecto")
print(f"Sesión iniciada como {r['user']['name']} ({rol}). Fecha de hoy: {hoy}\n")

resultados = []
def probar(nombre, ruta, resumen=None, publico=False):
    c, j = llamar("GET", ruta, token=None if publico else tk)
    ok = 200 <= c < 300 and j.get("success", True) is not False
    detalle = ""
    if ok and resumen:
        try: detalle = resumen(j)
        except Exception as e: detalle = f"(no pude resumir: {e})"
    elif not ok: detalle = f"HTTP {c} {j.get('message','')}"
    resultados.append(ok)
    print(("OK    " if ok else "FALLA ") + f"{nombre:34} {detalle}")
    return j if ok else {}

n = lambda k: (lambda j: f"{len(j.get(k) or j.get('data') or [])} registros")
probar("estado del servidor", "/health", publico=True)
probar("lista de nombres (login)", "/auth/users", n("data"), publico=True)
probar("menú: categorías", "/menu/categories", n("data"))
prods = probar("menú: productos", "/menu/products", n("data"))
probar("mesas", "/tables", n("data"))
probar("órdenes", "/orders", n("data"))
inv = probar("inventario", "/inventory", n("data"))
items = inv.get("data", [])
if items: probar("inventario: movimientos", f"/inventory/{items[0]['id']}/movements", n("data"))
st = probar("cierre: ventas del día", f"/pos-transactions/stats?date={hoy}", lambda j: str(j["summary"]))
probar("cierre: días con ventas", "/pos-transactions/days", n("data"))
probar("gastos del día", f"/pos-transactions/expenses?date={hoy}", n("data"))
probar("gastos por rango", f"/pos-transactions/expenses-range?from={hoy}&to={hoy}", n("data"))
probar("cierre guardado", f"/pos-transactions/cierre?date={hoy}", lambda j: "ya hay un cierre guardado" if j.get("data") else "sin cierre guardado hoy")
rec = probar("recetas", "/pos-transactions/recipes", n("data"))
hi = probar("historial del día", f"/historial?date={hoy}", lambda j: str(j["resumen"]))
probar("actividad por usuario", f"/actividad?date={hoy}", lambda j: f"{len(j['usuarios'])} usuarios")
probar("reportes: resumen", "/reports/summary?period=today")
probar("reportes: más vendidos", "/reports/top-products?period=today")
probar("historial de cierres", "/daily/history")
probar("cocina: historial", "/cocina/history", n("data"))
probar("tickets (registro viejo)", "/tickets", n("data"))
tc = probar("tickets compartidos", "/tickets-compartidos", lambda j: f"{len(j['tickets'])} tickets abiertos")
probar("usuarios", "/users", n("data"))
probar("2FA: estado", "/auth/2fa/status")

print("\n── Revisión de datos ──")
raros = 0
s, h = st.get("summary", {}), hi.get("resumen", {})
if s and h:
    for k in ("total_revenue", "efectivo", "tarjeta", "transferencia"):
        a = float(s.get(k, 0)); b = float(h.get({"total_revenue": "total"}.get(k, k), 0))
        if abs(a - b) > 0.01: raros += 1; print(f"DIFERENCIA cierre vs historial en {k}: cierre {a:.2f} / historial {b:.2f}")
for o in hi.get("data", []):
    if o["status"] == "paid" and not o["order_number"].startswith("VTA") and abs(o["cobrado"] - o["total"]) > 0.01:
        raros += 1; print(f"Cobro distinto al total: {o['order_number']} {o['mesa']} total {o['total']} cobrado {o['cobrado']}")
    suma = sum(float(i.get("subtotal") or 0) for i in o["items"])
    if abs(suma - o["total"]) > 0.01: raros += 1; print(f"Productos no suman el total: {o['order_number']} productos {suma:.2f} total {o['total']}")
# Las órdenes sin cobrar de hace horas las revisa el servidor (abajo), sin contar las de tickets abiertos.
# El inventario en cero no es una falla del sistema: sale abajo como información ("para comprar").
ids = {i["id"] for i in items}
for r_ in rec.get("data", []):
    iid = r_.get("inventory_item_id")
    if iid and iid not in ids: raros += 1; print(f"Receta de «{r_.get('product_name')}» apunta a un producto de inventario que no existe (id {iid})")
nombres = {p["name"].strip().lower() for p in prods.get("data", [])}
# Revisiones que hace el propio servidor sobre la base de datos (ruta solo de lectura para supervisores)
c, cons = llamar("GET", "/diagnostico/consistencia", token=tk)
if c == 200 and cons.get("success"):
    print("\n── Revisiones del servidor sobre la base de datos ──")
    for ch in cons["checks"]:
        if ch.get("info"):
            print(f"INFO ({ch['cantidad']}): {ch['nombre']}" + (f"  → no se pudo leer: {ch['error']}" if ch["error"] else ""))
            for e in ch["ejemplos"]: print("     ", e)
        elif ch["error"]:
            raros += 1; print(f"NO SE PUDO REVISAR: {ch['nombre']} → {ch['error']}")
        elif not ch["ok"]:
            raros += 1; print(f"REVISAR ({ch['cantidad']}): {ch['nombre']}")
            for e in ch["ejemplos"][:5]: print("     ", e)
        else:
            print(f"OK    {ch['nombre']}")
else:
    resultados.append(False)
    print(f"\nFALLA /diagnostico/consistencia (HTTP {c}): ¿ya está desplegado el backend nuevo y entraste como supervisor?")
print(f"\nRutas revisadas: {len(resultados)} · con falla: {resultados.count(False)} · datos raros: {raros}")
print("TODO BIEN" if not raros and all(resultados) else "HAY COSAS PARA REVISAR (mándale esta pantalla a Claude)")
