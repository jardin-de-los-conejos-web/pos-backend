#!/usr/bin/env python3
"""Uso (desde la carpeta del backend):  python3 scripts/arreglar_recetas.py

Quita las recetas que el diagnóstico encontró mal (es lo mismo que borrarlas en
Inventario → Recetas; el servidor solo las apaga, así que se pueden recuperar):
  · Smoothie → Pajillas Smothie   (la app ya la descuenta: salía doble)
  · Té frío Durazno → Durazno     (restaba el durazno de los bowls)
  · Té frío Limón → Limón         (restaba limones)
Y, si dices que sí, agrega Café → 1 Vaso Cafe.
Antes de cambiar algo muestra qué va a hacer y pide que escribas "si".
El PIN se escribe aquí en tu terminal (no se ve) y solo se manda al servidor."""
import getpass, json, os, re, sys, unicodedata, urllib.request, urllib.error

B = os.environ.get("POS_API", "https://el-jardin-de-los-conejos.up.railway.app/api")
QUITAR = [("Smoothie", "Pajillas Smothie"), ("Té frío Durazno", "Durazno"), ("Té frío Limón", "Limón")]
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

clave = lambda s: re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().lower())

pin = getpass.getpass("PIN de supervisor (no se ve al escribir): ")
c, r = llamar("POST", "/auth/login", {"role": "supervisor", "pin": pin})
if not r.get("success"): sys.exit("No se pudo iniciar sesión: " + str(r.get("message")))
tk = r["token"]
if r.get("user", {}).get("twoFactorEnabled") and not re.fullmatch(r"\d{6}", pin):
    c, v = llamar("POST", "/auth/2fa/verify-login", {"totpCode": input("Código de 2FA: ").strip()})
    if not v.get("success"): sys.exit("2FA incorrecto")

_, jr = llamar("GET", "/pos-transactions/recipes")
_, ji = llamar("GET", "/inventory")
recetas, items = jr.get("data") or [], ji.get("data") or []
if not recetas: sys.exit("No pude leer las recetas: " + str(jr.get("message")))

quitar = [x for x in recetas
          if any(clave(x["product_name"]) == clave(p) and clave(x["inventory_item_name"]) == clave(i) for p, i in QUITAR)]
print("\nRecetas que se van a quitar:")
for x in quitar: print(f"   · {x['product_name']} → {x['inventory_item_name']} ({float(x['quantity_used']):g} {x['unit']})")
if not quitar: print("   (ninguna: ya estaban quitadas)")

vaso = next((i for i in items if clave(i["name"]) == "vasocafe"), None)
cafe_vaso = any(clave(x["product_name"]) == "cafe" and vaso and x["inventory_item_id"] == vaso["id"] for x in recetas)
agregar_vaso = False
if vaso and not cafe_vaso:
    agregar_vaso = input("\n¿Cada Café lleva un 'Vaso Cafe'? (si = que también se descuente) escribe si o no: ").strip().lower() in ("si", "sí")

if not quitar and not agregar_vaso: sys.exit("\nNo hay nada que cambiar.")
if input("\n¿Hago estos cambios? escribe si: ").strip().lower() not in ("si", "sí"):
    sys.exit("No se cambió nada.")

for x in quitar:
    c, j = llamar("DELETE", f"/pos-transactions/recipes/{x['id']}")
    print(("OK    " if j.get("success") else "FALLA ") + f"quitar {x['product_name']} → {x['inventory_item_name']}"
          + ("" if j.get("success") else f"  ({j.get('message')})"))
if agregar_vaso:
    c, j = llamar("POST", "/pos-transactions/recipes",
                  {"product_name": "Café", "inventory_item_id": vaso["id"], "quantity_used": 1, "unit": vaso["unit"],
                   "notes": "Vaso de cada café"})
    print(("OK    " if j.get("success") else "FALLA ") + "agregar Café → 1 Vaso Cafe"
          + ("" if j.get("success") else f"  ({j.get('message')})"))
print("\nListo. Corre el diagnóstico otra vez: python3 scripts/diagnostico.py")
