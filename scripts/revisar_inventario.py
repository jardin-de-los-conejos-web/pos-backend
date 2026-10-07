#!/usr/bin/env python3
"""Uso (desde la carpeta del backend):  python3 scripts/revisar_inventario.py

1. Revisa que el inventario se esté rebajando bien (solo lee):
   · el Queso: sus últimos movimientos y qué ventas lo bajaron
   · recetas con unidades que no cuadran (ej. receta en "unidades" y producto en libras: cada
     venta restaría una libra entera) o con cantidad en cero
   · productos del menú que no tienen receta (al venderse no bajan nada por receta)
2. Al final pregunta si ajusta el Queso a 79 (conteo físico). Sin escribir "si" no cambia nada.
El PIN se escribe aquí en tu terminal (no se ve) y solo se manda al servidor."""
import collections, getpass, json, os, re, sys, unicodedata, urllib.request, urllib.error

B = os.environ.get("POS_API", "https://el-jardin-de-los-conejos.up.railway.app/api")
CONTEO_QUESO = 79
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
num = lambda v: float(v or 0)

def peso(u):
    t = re.sub(r"[^a-z]", "", clave(u))
    if t in ("g", "gr", "grs") or t.startswith("gramo"): return "g"
    if t == "kg" or t.startswith("kilo"): return "kg"
    if t in ("lb", "lbs") or t.startswith("libra"): return "lb"
    if t == "oz" or t.startswith("onza"): return "oz"
    return None

pin = getpass.getpass("PIN de supervisor (no se ve al escribir): ")
c, r = llamar("POST", "/auth/login", {"role": "supervisor", "pin": pin})
if not r.get("success"): sys.exit("No se pudo iniciar sesión: " + str(r.get("message")))
tk = r["token"]
usuario = r["user"]["name"]
if r.get("user", {}).get("twoFactorEnabled") and not re.fullmatch(r"\d{6}", pin):
    c, v = llamar("POST", "/auth/2fa/verify-login", {"totpCode": input("Código de 2FA: ").strip()})
    if not v.get("success"): sys.exit("2FA incorrecto")

_, ji = llamar("GET", "/inventory")
_, jr = llamar("GET", "/pos-transactions/recipes")
_, jp = llamar("GET", "/menu/products")
items = ji.get("data") or []
recetas = jr.get("data") or []
productos = jp.get("data") or []
if not items: sys.exit("No pude leer el inventario: " + str(ji.get("message")))

# ── 1. Queso ─────────────────────────────────────────────────────────────────
queso = next((i for i in items if clave(i["name"]) == "queso"), None)
print("\n══ 1. QUESO ══")
if not queso:
    print("No hay un producto llamado exactamente 'Queso' en Inventario.")
else:
    print(f"Ahora dice: {num(queso['quantity']):g} {queso['unit']}  (id {queso['id']})")
    usan = [x for x in recetas if x.get("inventory_item_id") == queso["id"]]
    print("\nRecetas que lo descuentan (cuánto resta cada venta):")
    for x in usan:
        print(f"   · {x['product_name']}: {num(x['quantity_used']):g} {x['unit']}")
    if not usan: print("   (ninguna)")

    _, jm = llamar("GET", f"/inventory/{queso['id']}/movements")
    movs = jm.get("data") or []
    print(f"\nÚltimos movimientos ({len(movs)}, del más nuevo al más viejo):")
    for m in movs[:25]:
        print(f"   {m['created_at'][:16].replace('T', ' ')}  {m['type']:<8} {num(m['quantity']):>7g}  {m.get('reason') or ''}  ({m.get('user_name') or ''})")
    # Qué lo bajó desde la última entrada o ajuste
    bajas = collections.Counter()
    for m in movs:
        if m["type"] in ("entrada", "ajuste"): break
        motivo = re.sub(r"\d+x ", "", re.sub(r"^Venta: ", "", m.get("reason") or "Sin motivo"))
        bajas[motivo] += num(m["quantity"])
    if bajas:
        print("\nLo que lo bajó desde la última entrada/ajuste:")
        for motivo, cant in bajas.most_common(): print(f"   -{cant:g}  {motivo}")

# ── 2. Recetas con problemas ─────────────────────────────────────────────────
print("\n══ 2. RECETAS QUE NO CUADRAN ══")
malas = 0
for x in recetas:
    ur, ui = x.get("unit"), x.get("item_unit")
    pr, pi = peso(ur), peso(ui)
    problema = None
    if num(x.get("quantity_used")) <= 0:
        problema = "la cantidad es 0: no descuenta nada"
    elif bool(pr) != bool(pi):
        problema = (f"la receta está en '{ur}' y el inventario en '{ui}': "
                    + ("cada venta resta en piezas lo que debería ser peso" if pi else "cada venta resta un peso en algo que se cuenta por pieza"))
    elif not pr and clave(ur) and clave(ui) and clave(ur).rstrip("s") != clave(ui).rstrip("s"):
        problema = f"la receta está en '{ur}' y el inventario en '{ui}' (no se convierten)"
    if problema:
        malas += 1
        print(f"   ✗ {x['product_name']} → {x['inventory_item_name']} ({num(x['quantity_used']):g} {ur}): {problema}")
if not malas: print("   OK: todas las recetas tienen unidades que cuadran con su inventario")

# ── 3. Productos del menú sin receta ─────────────────────────────────────────
print("\n══ 3. PRODUCTOS DEL MENÚ SIN RECETA ══")
con_receta = {clave(x["product_name"]) for x in recetas}
sin = [p["name"] for p in productos if clave(p["name"]) not in con_receta]
print("   Al venderse no bajan nada por receta (las bebidas, frutas, pajillas, hamburguesa, etc. las")
print("   descuenta la app aparte). Revisa que en esta lista no falte algo que SÍ lleva ingredientes:")
for n in sin: print(f"   · {n}")

# ── 4. En cero ───────────────────────────────────────────────────────────────
cero = [i for i in items if num(i["quantity"]) <= 0]
print("\n══ 4. EN CERO ══")
for i in cero: print(f"   · {i['name']} ({i['unit']})")
if not cero: print("   (ninguno)")

# ── 5. Ajuste del Queso ──────────────────────────────────────────────────────
if queso:
    print()
    if input(f"¿Ajusto el Queso a {CONTEO_QUESO} {queso['unit']} (conteo físico)? escribe si: ").strip().lower() in ("si", "sí"):
        c, j = llamar("POST", f"/inventory/{queso['id']}/adjust",
                      {"type": "ajuste", "quantity": CONTEO_QUESO,
                       "reason": f"Conteo físico: {CONTEO_QUESO} rodajas", "user_name": usuario})
        if j.get("success"):
            print(f"✅ Queso ajustado a {num(j['data']['quantity']):g} {queso['unit']}.")
        else:
            print("❌ No se pudo ajustar: " + str(j.get("message")))
    else:
        print("No se cambió el Queso.")
print("\nMándale a Claude todo lo que salió arriba.")
