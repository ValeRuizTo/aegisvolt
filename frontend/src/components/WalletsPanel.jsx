// Billeteras de las flotas: el saldo baja al reservar y vuelve si la carga se cancela.
import { useState } from 'react';
import { gql, money, TOPUP_MUTATION } from '../api.js';
import { Icon } from '../icons.jsx';

const TOPUP_AMOUNT = 100000;
const LOW_BALANCE = 20000;

export function WalletsPanel({ wallets, onChange }) {
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);

  async function topUp(fleetId) {
    setPending(fleetId);
    setError(null);
    try {
      await gql(TOPUP_MUTATION, { fleetId, amount: TOPUP_AMOUNT });
      await onChange();
    } catch {
      setError('No se pudo recargar la billetera. Inténtalo de nuevo.');
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="panel" aria-labelledby="wallets-title">
      <header className="panel-head">
        <h2 id="wallets-title">
          <Icon name="wallet" />
          Billeteras
        </h2>
      </header>
      <ul className="wallets">
        {wallets.map((wallet) => {
          const low = wallet.balance < LOW_BALANCE;
          return (
            <li key={wallet.fleetId} className={`wallet${low ? ' is-low' : ''}`} data-testid={`wallet-${wallet.fleetId}`}>
              <div className="wallet-info">
                <span className="wallet-name">{wallet.fleetName}</span>
                <span className="wallet-balance" data-testid={`balance-${wallet.fleetId}`}>
                  {money(wallet.balance, wallet.currency)}
                </span>
                {low && <span className="wallet-low">Saldo bajo</span>}
              </div>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={pending === wallet.fleetId}
                onClick={() => topUp(wallet.fleetId)}
                aria-label={`Recargar ${money(TOPUP_AMOUNT)} a ${wallet.fleetName}`}
              >
                <Icon name="plus" size={16} />
                {pending === wallet.fleetId ? 'Recargando…' : `Recargar ${money(TOPUP_AMOUNT)}`}
              </button>
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="callout callout-bad" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}
    </section>
  );
}
