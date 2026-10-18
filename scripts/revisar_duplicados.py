#!/usr/bin/env python3
"""Uso (desde la carpeta del backend):  python3 scripts/revisar_duplicados.py [AAAA-MM-DD]

Busca órdenes o productos REPETIDOS en un día (solo lee, no cambia nada) y dice para cada caso:
  · a qué hora exacta se guardó cada copia y cuántos segundos hay entre una y otra
  · quién la mandó (según "Actividad por usuario")
  · si parece de la app (segundos de diferencia: varios toques mientras se enviaba) o de la
    persona (minutos de diferencia: se volvió a ingresar).
Sin fecha revisa hoy. El PIN se escribe aquí en tu terminal (no se ve) y solo se manda al servidor."""
import collections, datetime, getpass, json, os, re, sys, urllib.request, urllib.error

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

def hora(iso):
    if not iso: return None
    return datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00"))

def local(d):
    return (d - datetime.timedelta(hours=6)).strftime("%H:%M:%S") if d else "?"

def veredicto(segundos):
    if segundos <= 20:
        return "⚠️  APP: segundos de diferencia → se tocó el botón varias veces mientras se enviaba (o reintento por internet lento)"
    if segundos <= 90:
        return "❓ DUDOSO: poco más de un minuto entre una y otra"
    return "👤 PERSONA: minutos de diferencia → se volvió a ingresar a mano"

hoy = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=6)).strftime("%Y-%m-%d")
fecha = sys.argv[1] if len(sys.argv) > 1 else hoy
if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", fecha): sys.exit("La fecha va así: 2026-10-17")

pin = getpass.getpass("PIN de supervisor (no se ve al escribir): ")
c, r = llamar("POST", "/auth/login", {"role": "supervisor", "pin": pin})
if not r.get("success"): sys.exit("No se pudo iniciar sesión: " + str(r.get("message")))
tk = r["token"]
if r.get("user", {}).get("twoFactorEnabled") and not re.fullmatch(r"\d{6}", pin):
    c, v = llamar("POST", "/auth/2fa/verify-login", {"totpCode": input("Código de 2FA: ").strip()})
    if not v.get("success"): sys.exit("2FA incorrecto")

c, h = llamar("GET", f"/historial?date={fecha}")
ordenes = h.get("data", [])
c, a = llamar("GET", f"/actividad?date={fecha}")
quien = collections.defaultdict(set)
for f in a.get("data", []):
    if f.get("tipo") == "orden" and f.get("order_id"): quien[f["order_id"]].add(f.get("user_name") or "?")
print(f"\nDía {fecha}: {len(ordenes)} órdenes\n")

encontrados = 0

# 1. Órdenes iguales de la misma mesa o ticket (mismos productos y cantidades) en menos de 30 min
def firma(o):
    return tuple(sorted((i["name"], float(i["quantity"]), float(i.get("subtotal") or 0)) for i in o.get("items", [])))
por_cuenta = collections.defaultdict(list)
for o in ordenes:
    if o.get("items"): por_cuenta[(o["mesa"], firma(o))].append(o)
for (mesa, _), grupo in por_cuenta.items():
    if len(grupo) < 2: continue
    grupo.sort(key=lambda o: o["created_at"])
    primero = hora(grupo[0]["created_at"])
    ultimo = hora(grupo[-1]["created_at"])
    if (ultimo - primero).total_seconds() > 30 * 60: continue
    encontrados += 1
    print(f"── {len(grupo)} ÓRDENES IGUALES · {mesa} ──")
    print("   Productos: " + ", ".join(f"{int(i['quantity'])}x {i['name']}" for i in grupo[0]["items"]))
    for o in grupo:
        print(f"   {o['order_number']}  guardada {local(hora(o['created_at']))}  estado {o['status']}  "
              f"total Q{float(o['total']):.2f}  mandó: {', '.join(sorted(quien.get(o['id'], {'?'})))}")
    seg = min((hora(b["created_at"]) - hora(x["created_at"])).total_seconds() for x, b in zip(grupo, grupo[1:]))
    print(f"   Menor tiempo entre copias: {seg:.0f} s")
    print("   " + veredicto(seg) + "\n")

# 2. Dentro de una misma orden, el mismo producto agregado varias veces
for o in ordenes:
    por_producto = collections.defaultdict(list)
    for i in o.get("items", []):
        por_producto[(i["name"], i.get("notes") or "")].append(i)
    for (nombre, _), lista in por_producto.items():
        if len(lista) < 2 or not all(i.get("created_at") for i in lista): continue
        lista.sort(key=lambda i: i["created_at"])
        seg = min((hora(b["created_at"]) - hora(x["created_at"])).total_seconds() for x, b in zip(lista, lista[1:]))
        if seg > 30 * 60: continue
        encontrados += 1
        print(f"── {o['order_number']} · {o['mesa']}: '{nombre}' está {len(lista)} veces ──")
        for i in lista:
            print(f"   {int(i['quantity'])}x {nombre}  agregado {local(hora(i['created_at']))}")
        print(f"   Menor tiempo entre una y otra: {seg:.0f} s · mandó: {', '.join(sorted(quien.get(o['id'], {'?'})))}")
        print("   " + veredicto(seg) + "\n")

# 3. En "Actividad por usuario" queda cada envío AUNQUE la orden se haya anulado después.
#    Órdenes nuevas con la misma mesa y productos, mandadas con poco tiempo entre una y otra.
anuladas = {f["order_id"] for f in a.get("data", []) if f.get("tipo") == "cancelacion" and f.get("order_id")}
ids_historial = {o["id"] for o in ordenes}
envios = collections.defaultdict(list)
for f in a.get("data", []):
    det = (f.get("detalle") or "").strip()
    if f.get("tipo") != "orden" or not f.get("order_id") or not det or det.startswith("Agregó"): continue
    envios[det].append(f)
for det, lista in envios.items():
    ordenes_distintas = {f["order_id"] for f in lista}
    if len(ordenes_distintas) < 2: continue
    lista.sort(key=lambda f: f["created_at"])
    seg = min((hora(y["created_at"]) - hora(x["created_at"])).total_seconds() for x, y in zip(lista, lista[1:]))
    if seg > 30 * 60: continue
    encontrados += 1
    print(f"── {len(ordenes_distintas)} ÓRDENES MANDADAS IGUALES (según Actividad) ──")
    print(f"   {det}")
    for f in lista:
        estado = ("anulada" if f["order_id"] in anuladas or f["order_id"] not in ids_historial else "sigue en el historial")
        print(f"   orden #{f['order_id']}  mandada {local(hora(f['created_at']))}  por {f.get('user_name') or '?'}  ({estado})")
    print(f"   Menor tiempo entre envíos: {seg:.0f} s")
    print("   " + veredicto(seg) + "\n")

if not encontrados:
    print("✅ No encontré órdenes ni productos repetidos ese día.")
print("Mándale a Claude todo lo que salió arriba.")
