#!/usr/bin/env python3
"""Uso (desde la carpeta del backend):  python3 scripts/revisar_orden.py ORD-20261016-0445

Revisa UNA orden (solo lee, no cambia nada): qué se pidió, el total, cómo se pagó (efectivo,
tarjeta, transferencia y el cambio que se dio) y cuánto entró al cierre de caja.
Sirve para confirmar que un cambio dado no quedó sumado en el cierre.
El PIN se escribe aquí en tu terminal (no se ve) y solo se manda al servidor."""
import datetime, getpass, json, os, re, sys, urllib.request, urllib.error

B = os.environ.get("POS_API", "https://el-jardin-de-los-conejos.up.railway.app/api")
tk = None

def llamar(metodo, ruta, cuerpo=None):
    req = urllib.request.Request(B + ruta, method=metodo, data=json.dumps(cuerpo).encode() if cuerpo is not None else None)
    req.add_header("Content-Type", "application/json")
    if tk: req.add_header("Authorization", "Bearer " + tk)
    try:
        with urllib.request.urlopen(req, timeout=40) as r: return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try: return e.code, json.load(e)
        except Exception: return e.code, {}
    except Exception as e:
        return 0, {"message": str(e)}

numero = (sys.argv[1] if len(sys.argv) > 1 else input("Número de orden (ej. ORD-20261016-0445): ")).strip().upper()
if not numero.startswith("ORD-"): numero = "ORD-" + numero
m = re.match(r"ORD-(\d{4})(\d{2})(\d{2})-", numero)
if not m: sys.exit("Escribe el número completo, ej. ORD-20261016-0445")

pin = getpass.getpass("PIN de supervisor (no se ve al escribir): ")
c, r = llamar("POST", "/auth/login", {"role": "supervisor", "pin": pin})
if not r.get("success"): sys.exit("No se pudo iniciar sesión: " + str(r.get("message")))
tk = r["token"]
if r.get("user", {}).get("twoFactorEnabled") and not re.fullmatch(r"\d{6}", pin):
    c, v = llamar("POST", "/auth/2fa/verify-login", {"totpCode": input("Código de 2FA: ").strip()})
    if not v.get("success"): sys.exit("2FA incorrecto")

# El número lleva la fecha en hora UTC; en Guatemala puede ser el día anterior: se buscan los dos.
fecha_num = datetime.date(int(m[1]), int(m[2]), int(m[3]))
orden = None
for d in (fecha_num - datetime.timedelta(days=1), fecha_num):
    c, h = llamar("GET", f"/historial?date={d.isoformat()}")
    orden = next((o for o in h.get("data", []) if o.get("order_number") == numero), None)
    if orden: break
if not orden: sys.exit(f"No encontré {numero} en el historial de esos días.")

q = lambda v: f"Q{float(v or 0):.2f}"
print(f"\n{numero} · {orden['mesa']} · estado: {orden['status']}")
print("Lo que se pidió:")
for i in orden.get("items", []):
    print(f"   {i.get('quantity')}x {i.get('name')}  {q(i.get('subtotal'))}")
print(f"TOTAL DE LA ORDEN: {q(orden['total'])}")
print(f"Cobrado: {q(orden['cobrado'])}  (efectivo {q(orden['efectivo'])} · tarjeta {q(orden['tarjeta'])} · transferencia {q(orden['transferencia'])})")

# Cuánto entró al cierre por esta orden (revisión de solo lectura del servidor)
c, cons = llamar("GET", "/diagnostico/consistencia")
fila = None
for ch in cons.get("checks", []):
    if ch["nombre"].startswith("Cobros de hoy en el cierre"):
        fila = next((e for e in ch.get("ejemplos", []) if e.get("order_number") == numero), None)
if fila:
    print(f"ENTRÓ AL CIERRE: {q(fila['en_cierre'])}  ({fila['metodos']}, cobrada a las {fila['hora_cobro']})")
    dif = round(float(fila["en_cierre"]) - float(orden["total"]), 2)
    if abs(dif) < 0.01:
        print("\n✅ El cierre tiene exactamente el total de la orden: el cambio NO se sumó al cierre.")
    elif dif > 0:
        print(f"\n⚠️ El cierre tiene {q(dif)} DE MÁS sobre el total de la orden. Mándale esta pantalla a Claude.")
    else:
        print(f"\n⚠️ Al cierre le faltan {q(-dif)} para el total de la orden. Mándale esta pantalla a Claude.")
else:
    print("\n(No salió en los cobros de hoy del cierre: si se cobró otro día, mándale esta pantalla a Claude.)")
