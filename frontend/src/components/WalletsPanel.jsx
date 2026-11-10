// Billeteras de las flotas (saldo en vivo: baja al cobrar, vuelve al reembolsar).
import { useState } from 'react';
import { gql, money, TOPUP_MUTATION } from '../api.js';

const TOPUP_AMOUNT = 100000;

export function WalletsPanel({ wallets, onChange }) {
  const [pending, setPending] = useState(null);

  async function topUp(fleetId) {
    setPending(fleetId);
    try {
      await gql(TOPUP_MUTATION, { fleetId, amount: TOPUP_AMOUNT });
      await onChange();
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="panel panel-wallets" aria-labelledby="wallets-title">
      <div className="panel-head">
        <h2 id="wallets-title">Billeteras de flota</h2>
      </div>
      <ul className="wallets">
        {wallets.map((wallet) => (
          <li key={wallet.fleetId} className="wallet" data-testid={`wallet-${wallet.fleetId}`}>
            <div>
              <span className="wallet-name">{wallet.fleetName}</span>
              <code>{wallet.fleetId}</code>
            </div>
            <span className="wallet-balance" data-testid={`balance-${wallet.fleetId}`}>
              {money(wallet.balance, wallet.currency)}
            </span>
            <button type="button" className="link" disabled={pending === wallet.fleetId} onClick={() => topUp(wallet.fleetId)}>
              + {money(TOPUP_AMOUNT)}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
