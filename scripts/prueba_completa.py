#!/usr/bin/env python3
"""Uso (desde la carpeta del backend):  python3 scripts/prueba_completa.py

Prueba de punta a punta lo que ESCRIBE en el servidor (el diagnóstico solo lee):
  1. Ticket compartido de prueba y una orden con un producto del menú.
  2. "Agregar items" a la orden abierta: Envío, un producto personalizado y otro del menú.
  3. Que la orden salga en "órdenes abiertas" (lo que ven los demás iPads) y en tickets compartidos.
  4. Que el ticket NO se pueda borrar con dinero pendiente.
  5. Cobros: efectivo con vuelto, tarjeta (Para llevar), transferencia y combinado.
  6. Que cada cobro llegue al cierre de caja con su método y monto exacto.
  7. LIMPIEZA: borra todo lo de prueba ("Eliminar transacciones") y revisa que el cierre
     quede igual que antes. La limpieza corre aunque algo falle a medio camino.

Escribe en la base de datos REAL, por eso conviene correrlo con el restaurante cerrado
(si alguien cobra mientras corre, los números del cierre no cuadrarían con la prueba).
Usa un producto del menú SIN receta y sin control de stock: no mueve el inventario.
El PIN se escribe aquí en tu terminal (no se ve) y solo se manda al servidor."""
import getpass, json, os, random, re, sys, datetime, unicodedata, urllib.request, urllib.error

B = os.environ.get("POS_API", "https://el-jardin-de-los-conejos.up.railway.app/api")
hoy = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=6)).strftime("%Y-%m-%d")
NOMBRE = "PRUEBA AUTOMATICA (se borra sola)"
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

fallas = []
def revisar(ok, texto, detalle=""):
    print(("OK    " if ok else "FALLA ") + texto + (f"  ({detalle})" if detalle and not ok else ""))
    if not ok: fallas.append(texto)
    return ok

num = lambda v: float(v or 0)
r2 = lambda v: round(float(v) + 1e-9, 2)
clave = lambda s: re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode().lower())

def cierre():
    c, j = llamar("GET", f"/pos-transactions/stats?date={hoy}")
    s = j.get("summary") or {}
    return {k: r2(num(s.get(k))) for k in ("efectivo", "tarjeta", "transferencia", "total_revenue")}

# ── Sesión ──────────────────────────────────────────────────────────────────
pin = getpass.getpass("PIN de supervisor (no se ve al escribir): ")
c, r = llamar("POST", "/auth/login", {"role": "supervisor", "pin": pin})
if not r.get("success"): sys.exit("No se pudo iniciar sesión: " + str(r.get("message")))
tk = r["token"]
if r.get("user", {}).get("twoFactorEnabled") and not re.fullmatch(r"\d{6}", pin):
    c, v = llamar("POST", "/auth/2fa/verify-login", {"totpCode": input("Código de 2FA: ").strip()})
    if not v.get("success"): sys.exit("2FA incorrecto")
print(f"Sesión iniciada como {r['user']['name']}. Fecha: {hoy}\n")

# ── Producto del menú sin receta ni stock (no toca el inventario) ───────────
c, jp = llamar("GET", "/menu/products")
c, jr = llamar("GET", "/pos-transactions/recipes")
con_receta = {clave(x.get("product_name") or x.get("productName") or "") for x in (jr.get("data") or [])}
candidatos = [p for p in (jp.get("data") or [])
              if num(p.get("price")) > 0 and p.get("is_available") is not False
              and p.get("stock") is None and clave(p.get("name")) not in con_receta]
if not candidatos: sys.exit("No encontré un producto del menú sin receta y sin stock para probar. No se hizo nada.")
prod = sorted(candidatos, key=lambda p: num(p["price"]))[0]
P = r2(num(prod["price"]))
print(f"Producto del menú para la prueba: {prod['name']} (Q{P:.2f}, sin receta: no mueve inventario)")
if clave("Envío") in con_receta:
    print("Ojo: 'Envío' tiene receta; lo que descuente se regresa al borrar la prueba.")

antes = cierre()
print(f"Cierre de hoy antes de la prueba: {antes}\n")
if input("Esto crea órdenes y cobros de prueba y luego los borra. ¿Seguimos? escribe si: ").strip().lower() not in ("si", "sí"):
    sys.exit("No se hizo nada.")

ordenes, cid = [], -random.randint(900_000_000, 999_999_999)
ticket_creado = False

def crear_orden(tipo, items):
    c, j = llamar("POST", "/orders", {"table_number": NOMBRE, "type": tipo, "people_count": 1, "items": items})
    oid = (j.get("data") or {}).get("id")
    if oid: ordenes.append(oid)
    return c, j, oid

def total_servidor(oid):
    c, j = llamar("GET", f"/orders/{oid}")
    d = j.get("data") or {}
    return r2(num(d.get("total"))), d

def cobrar(oid, cuerpo, esperado, titulo):
    antes_c = cierre()
    c, j = llamar("POST", "/payments", {"order_id": oid, **cuerpo})
    if not revisar(j.get("success") is True, f"{titulo}: el servidor aceptó el cobro", j.get("message")): return
    despues = cierre()
    for met, monto in esperado.items():
        delta = r2(despues[met] - antes_c[met])
        revisar(abs(delta - monto) < 0.01, f"{titulo}: llegó Q{monto:.2f} en {met} al cierre", f"llegó Q{delta:.2f}")
    _, d = total_servidor(oid)
    revisar(d.get("status") == "paid", f"{titulo}: la orden quedó cobrada", d.get("status"))

menu_item = {"product_id": prod["id"], "quantity": 1, "unit_price": P}
envio = {"product_name": "Envío", "unit_price": 15, "quantity": 1, "notes": "Persona 1 | Cobro por envío"}

try:
    # 1. Ticket compartido + orden
    print("\n── 1. Ticket y orden ──")
    c, j = llamar("PUT", f"/tickets-compartidos/{cid}", {"name": NOMBRE, "peopleCount": 1, "userName": "Prueba automática"})
    ticket_creado = j.get("success") is True
    revisar(ticket_creado, "crear ticket compartido", j.get("message"))
    c, j, A = crear_orden("dine_in", [menu_item])
    revisar(bool(A), "crear orden con producto del menú", j.get("message"))
    if not A: raise RuntimeError("sin orden no se puede seguir")
    llamar("PUT", f"/tickets-compartidos/{cid}", {"orderId": A})

    # 2. Agregar items a la orden abierta (lo que falló el 6 de octubre)
    print("\n── 2. Agregar items a la orden abierta ──")
    for nombre, cuerpo in [("Envío (sin producto del menú)", envio),
                           ("producto personalizado con notas", {"product_name": "PRUEBA personalizado", "unit_price": 10,
                                                                  "quantity": 2, "notes": "Persona 1 | Nota de prueba"}),
                           ("producto del menú", {**menu_item, "notes": "Persona 1"})]:
        c, j = llamar("POST", f"/orders/{A}/items", cuerpo)
        revisar(j.get("success") is True, f"agregar {nombre}", j.get("message"))
    esperado_A = r2(P + 15 + 20 + P)
    tA, dA = total_servidor(A)
    revisar(abs(tA - esperado_A) < 0.01, f"total de la orden en el servidor = Q{esperado_A:.2f}", f"servidor Q{tA:.2f}")
    revisar(len([i for i in dA.get("items", []) if i.get("status") != "cancelled"]) == 4, "la orden tiene los 4 productos")

    # 3. Lo que ven los demás iPads
    print("\n── 3. Lo que ven los demás iPads ──")
    c, j = llamar("GET", "/orders?status=open,in_progress,ready,delivered")
    revisar(any(o.get("id") == A for o in (j.get("data") or [])), "la orden sale en 'órdenes abiertas' (mesas en otros iPads)")
    c, j = llamar("GET", "/tickets-compartidos")
    t = next((x for x in (j.get("tickets") or []) if x.get("clientId") == cid), None)
    revisar(t is not None and t.get("orderAbierta") is True, "el ticket sale en los demás iPads con su orden")
    if t: revisar(abs(num(t.get("total")) - esperado_A) < 0.01, "el ticket compartido muestra el total correcto", t.get("total"))

    # 4. No se puede borrar con dinero pendiente
    print("\n── 4. Ticket con dinero pendiente ──")
    c, j = llamar("DELETE", f"/tickets-compartidos/{cid}")
    revisar(c == 409, "no deja borrar un ticket con dinero por pagar", f"respondió {c}")

    # 5. Cobros
    print("\n── 5. Cobros y cierre de caja ──")
    cobrar(A, {"method": "cash", "amount_paid": esperado_A + 10, "change": 10}, {"efectivo": esperado_A},
           "efectivo con vuelto de Q10")

    c, j, Bo = crear_orden("takeout", [menu_item])
    if revisar(bool(Bo), "crear orden Para llevar", j.get("message")):
        c, j = llamar("POST", f"/orders/{Bo}/items", envio)
        revisar(j.get("success") is True, "agregar Envío al Para llevar", j.get("message"))
        tB, _ = total_servidor(Bo)
        cobrar(Bo, {"method": "card", "amount_paid": tB, "change": 0}, {"tarjeta": tB}, "Para llevar con tarjeta")

    c, j, C = crear_orden("dine_in", [menu_item])
    if revisar(bool(C), "crear orden para transferencia", j.get("message")):
        tC, _ = total_servidor(C)
        cobrar(C, {"method": "transfer", "amount_paid": tC, "change": 0}, {"transferencia": tC}, "transferencia")

    c, j, D = crear_orden("dine_in", [menu_item, {"product_name": "PRUEBA personalizado", "unit_price": 30, "quantity": 1}])
    if revisar(bool(D), "crear orden para pago combinado", j.get("message")):
        tD, _ = total_servidor(D)
        tarjeta, transf = 10.0, 5.0
        efectivo = r2(tD - tarjeta - transf)
        cobrar(D, {"method": "mixed", "amount_paid": tD, "cash_amount": efectivo, "card_amount": tarjeta,
                   "transfer_amount": transf, "change": 0},
               {"efectivo": efectivo, "tarjeta": tarjeta, "transferencia": transf}, "pago combinado")

    c, j = llamar("POST", f"/payments", {"order_id": A, "method": "cash", "amount_paid": esperado_A, "change": 0})
    revisar(c == 400, "no deja cobrar dos veces la misma orden", f"respondió {c}")

except Exception as e:
    revisar(False, "la prueba se detuvo", str(e))

finally:
    # 7. Limpieza: siempre
    print("\n── Limpieza ──")
    for oid in ordenes:
        c, j = llamar("POST", f"/ajustes/ordenes/{oid}/eliminar", {"user_name": "Prueba automática"})
        revisar(j.get("success") is True, f"borrar orden de prueba {oid}", j.get("message"))
    if ticket_creado:
        c, j = llamar("DELETE", f"/tickets-compartidos/{cid}")
        revisar(j.get("success") is True, "borrar ticket de prueba", j.get("message"))
    despues = cierre()
    revisar(despues == antes, "el cierre de caja quedó igual que antes de la prueba", f"antes {antes} · ahora {despues}")

print()
if fallas:
    print(f"❌ {len(fallas)} cosa(s) fallaron:")
    for f in fallas: print("   - " + f)
    print("Mándame todo lo que salió arriba.")
    sys.exit(1)
print("✅ Todo funcionó: agregar items, órdenes abiertas, tickets compartidos, cobros en los 3 métodos y combinado, y la limpieza.")
print("   En 'Actividad por usuario' de hoy quedan anotadas las acciones de la prueba a tu nombre.")
