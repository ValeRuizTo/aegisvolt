# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Operadores de flotas comerciales de vehículos eléctricos de reparto urbano en Latinoamérica: el
despachador que, durante la jornada, reserva bahías de carga rápida para sus vehículos, vigila que la
carga avance y controla el saldo de la billetera de la flota. No es una persona técnica: piensa en
vehículos, conectores, kWh y pesos, no en servicios ni transacciones distribuidas.

Audiencia secundaria (confirmada): evaluadores técnicos que necesitan ver, a demanda, los detalles
técnicos de cada operación.

## Product Purpose
Reservar un conector de carga, retener el saldo estimado y activar la carga en una sola acción; ver
en tiempo casi real la disponibilidad de las electrolineras, las cargas en curso y los movimientos de
la billetera. Si el cargador falla o no hay saldo, la operación se deshace sola (se libera el conector
y se devuelve el dinero) y el operador debe entenderlo sin ayuda.

## Operating Context
- Tres ambientes del mismo producto (dev, test, prod) servidos con la misma interfaz; el operador
  debe saber siempre en cuál está.
- La pantalla se refresca sola cada 2,5 s consultando un único endpoint GraphQL relativo a la página.
- Moneda COP sin decimales; energía en kWh; potencia en kW. Idioma: español.

## Capabilities and Constraints
- Funciones: estado de electrolineras y conectores; reservar y activar carga (con ultra-carga opcional);
  detener una carga; cotización en vivo; billeteras con recarga; historial de operaciones; ajustes del
  ambiente (feature flags) activables desde la pantalla.
- Las tres feature flags son reales y deben seguir visibles y conmutables: tarifa dinámica en hora pico,
  ultra-carga prioritaria, simulación de avería del cargador (modo de pruebas).
- Los atributos `data-testid` existentes son contrato con las pruebas E2E y no pueden cambiar de nombre.
- Lo técnico (pasos internos de la operación, identificador de rastreo `correlation_id`, versión de cada
  servicio, nombres internos de flags y tablas) queda oculto por defecto tras un control
  "Ver detalle técnico"; nunca se elimina.
- Terminología de usuario: "operación" (no SAGA), "se deshizo" / "devuelto" (no compensación),
  "ajustes del ambiente" (no feature flags).

## Brand Commitments
Nombre: AegisVolt. Color por ambiente ya establecido y obligatorio: dev verde, test ámbar, prod rojo.

## Evidence on Hand
Datos sembrados de demostración: 3 electrolineras (Bogotá, Medellín, Cali), 9 conectores, 3 flotas
(Andes, Pacífico, Caribe). No hay clientes, testimonios ni métricas reales: no inventarlos.

## Product Principles
1. El operador entiende cada resultado sin saber cómo funciona por dentro.
2. Nunca hay duda de en qué ambiente se está operando.
3. El dinero y la disponibilidad se ven siempre: son las dos cosas que el operador vigila.
4. Lo técnico está a un clic, nunca en el camino.

## Accessibility & Inclusion
Contraste WCAG AA, estados no comunicados solo por color, navegable con teclado, respeto a
`prefers-reduced-motion`.
