import React, { useCallback, useMemo, useState } from 'react'
import { clusterApiUrl, Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { 
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  createInitializeMint2Instruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getMinimumBalanceForRentExemptMint
} from '@solana/spl-token'
import { 
  createCreateMetadataAccountV3Instruction,
  PROGRAM_ID as TOKEN_METADATA_PROGRAM_ID
} from '@metaplex-foundation/mpl-token-metadata'

import {
  ConnectionProvider,
  WalletProvider,
  useWallet
} from '@solana/wallet-adapter-react'
import {
  WalletModalProvider,
  WalletMultiButton
} from '@solana/wallet-adapter-react-ui'
import { PhantomWalletAdapter, SolflareWalletAdapter, SolletExtensionWalletAdapter, BackpackWalletAdapter, SolongWalletAdapter } from '@solana/wallet-adapter-wallets'

const DEFAULT_RPC = (import.meta as any).env?.VITE_RPC_URL || clusterApiUrl('devnet')

function AppWrapper() {
  const wallets = useMemo(() => [
    new PhantomWalletAdapter(),
    new SolflareWalletAdapter(),
    new BackpackWalletAdapter(),
    new SolongWalletAdapter(),
    new SolletExtensionWalletAdapter(),
  ], [])

  return (
    <ConnectionProvider endpoint={DEFAULT_RPC}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <App/>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}

function App() {
  return (
    <div className="container">
      <div className="header">
        <h1>🧰 Solana Meme Bundler</h1>
        <WalletMultiButton />
      </div>
      <div className="grid" style={{marginTop: 16}}>
        <div className="card"><BundlerForm/></div>
        <div className="card"><Logs/></div>
      </div>
      <p style={{opacity:.75, marginTop: 8}}>
        Devnet only by default. Set <span className="kbd">VITE_RPC_URL</span> for a custom endpoint.
      </p>
    </div>
  )
}

type Log = { ts: string, level: 'info'|'ok'|'error', msg: string }
const logQueue: Log[] = []

function log(level: Log['level'], msg: string) {
  logQueue.push({ ts: new Date().toLocaleTimeString(), level, msg })
  window.dispatchEvent(new CustomEvent('log-update'))
}

function Logs() {
  const [, setTick] = useState(0)
  React.useEffect(() => {
    const onUpd = () => setTick(t => t + 1)
    window.addEventListener('log-update', onUpd)
    return () => window.removeEventListener('log-update', onUpd)
  }, [])
  return (
    <div>
      <h3 style={{marginTop:0}}>📜 Logs</h3>
      <div style={{maxHeight: 460, overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 13}}>
        {logQueue.slice(-500).map((l, i) => (
          <div key={i} style={{opacity: l.level==='info'?0.9:1, color: l.level==='ok' ? 'var(--success)' : l.level==='error' ? 'var(--danger)' : 'var(--text)'}}>
            [{l.ts}] {l.msg}
          </div>
        ))}
      </div>
    </div>
  )
}

function BundlerForm() {
  const wallet = useWallet()
  const [name, setName] = useState('Meme Coin')
  const [symbol, setSymbol] = useState('MEME')
  const [decimals, setDecimals] = useState(6)
  const [supply, setSupply] = useState(1_000_000)
  const [uri, setUri] = useState('') // e.g. ipfs://... JSON with {name,symbol,description,image,attributes}
  const [busy, setBusy] = useState(false)
  const [mintPubkey, setMintPubkey] = useState<PublicKey | null>(null)

  const connection = useMemo(() => new Connection(DEFAULT_RPC, 'confirmed'), [])

  const airdrop = useCallback(async () => {
    if (!wallet.publicKey) return
    log('info', 'Requesting airdrop of 1 SOL (devnet)...')
    const sig = await connection.requestAirdrop(wallet.publicKey, 1 * LAMPORTS_PER_SOL)
    await connection.confirmTransaction(sig, 'confirmed')
    log('ok', 'Airdrop complete.')
  }, [wallet.publicKey, connection])

  const run = useCallback(async () => {
    if (!wallet.publicKey || !wallet.signTransaction) {
      log('error', 'Connect a wallet first.')
      return
    }
    setBusy(true)
    try {
      const payer = wallet.publicKey
      const mintKeypair = Keypair.generate()
      log('info', `Generated mint keypair: ${mintKeypair.publicKey.toBase58()}`)

      // 1) Create Mint account + initialize
      const rent = await getMinimumBalanceForRentExemptMint(connection)
      const tx1 = new Transaction()
      tx1.add(SystemProgram.createAccount({
        fromPubkey: payer,
        newAccountPubkey: mintKeypair.publicKey,
        lamports: rent,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID
      }))
      tx1.add(createInitializeMint2Instruction(mintKeypair.publicKey, decimals, payer, payer, TOKEN_PROGRAM_ID))

      tx1.feePayer = payer
      const bh = await connection.getLatestBlockhash()
      tx1.recentBlockhash = bh.blockhash
      tx1.partialSign(mintKeypair)
      const signedTx1 = await wallet.signTransaction(tx1)
      const sig1 = await connection.sendRawTransaction(signedTx1.serialize(), { skipPreflight: false })
      await connection.confirmTransaction({ signature: sig1, ...bh }, 'confirmed')
      log('ok', `Mint created: ${mintKeypair.publicKey.toBase58()} | tx: ${sig1}`)

      // 2) Create Metadata (optional but recommended)
      if (uri && name && symbol) {
        const [metadataPda] = PublicKey.findProgramAddressSync(
          [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintKeypair.publicKey.toBuffer()],
          TOKEN_METADATA_PROGRAM_ID
        )
        const metadataIx = createCreateMetadataAccountV3Instruction({
          metadata: metadataPda,
          mint: mintKeypair.publicKey,
          mintAuthority: payer,
          payer,
          updateAuthority: payer
        }, {
          createMetadataAccountArgsV3: {
            data: {
              name,
              symbol,
              uri,
              sellerFeeBasisPoints: 0,
              creators: null,
              collection: null,
              uses: null
            },
            isMutable: true,
            collectionDetails: null
          }
        })

        const tx2 = new Transaction().add(metadataIx)
        tx2.feePayer = payer
        const bh2 = await connection.getLatestBlockhash()
        tx2.recentBlockhash = bh2.blockhash
        const signedTx2 = await wallet.signTransaction(tx2)
        const sig2 = await connection.sendRawTransaction(signedTx2.serialize(), { skipPreflight: false })
        await connection.confirmTransaction({ signature: sig2, ...bh2 }, 'confirmed')
        log('ok', `Metadata set | tx: ${sig2}`)
      } else {
        log('info', 'Metadata skipped (fill Name/Symbol/URI to enable).')
      }

      // 3) Create ATA for payer
      const ata = getAssociatedTokenAddressSync(mintKeypair.publicKey, payer)
      const ixATA = createAssociatedTokenAccountInstruction(payer, ata, payer, mintKeypair.publicKey)
      const tx3 = new Transaction().add(ixATA)
      tx3.feePayer = payer
      const bh3 = await connection.getLatestBlockhash()
      tx3.recentBlockhash = bh3.blockhash
      const signedTx3 = await wallet.signTransaction(tx3)
      const sig3 = await connection.sendRawTransaction(signedTx3.serialize(), { skipPreflight: false })
      await connection.confirmTransaction({ signature: sig3, ...bh3 }, 'confirmed')
      log('ok', `ATA created: ${ata.toBase58()} | tx: ${sig3}`)

      // 4) Mint supply to payer
      const amount = BigInt(Math.floor(supply)) * BigInt(10 ** decimals)
      const ixMint = createMintToInstruction(mintKeypair.publicKey, ata, payer, Number(amount))
      const tx4 = new Transaction().add(ixMint)
      tx4.feePayer = payer
      const bh4 = await connection.getLatestBlockhash()
      tx4.recentBlockhash = bh4.blockhash
      const signedTx4 = await wallet.signTransaction(tx4)
      const sig4 = await connection.sendRawTransaction(signedTx4.serialize(), { skipPreflight: false })
      await connection.confirmTransaction({ signature: sig4, ...bh4 }, 'confirmed')
      log('ok', `Minted ${supply} tokens (decimals: ${decimals}) | tx: ${sig4}`)

      setMintPubkey(mintKeypair.publicKey)
      log('ok', 'Bundler complete ✅')
    } catch (e: any) {
      console.error(e)
      log('error', e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }, [wallet.publicKey, wallet.signTransaction, connection, name, symbol, uri, decimals, supply])

  return (
    <div>
      <h3 style={{marginTop:0}}>🚀 Bundle</h3>
      <div style={{display:'grid', gap:12}}>
        <label>Token name
          <input className="input" value={name} onChange={e=>setName(e.target.value)}/>
        </label>
        <label>Symbol
          <input className="input" value={symbol} onChange={e=>setSymbol(e.target.value)}/>
        </label>
        <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:12}}>
          <label>Decimals
            <input className="input" type="number" min={0} max={9} value={decimals} onChange={e=>setDecimals(parseInt(e.target.value||'0'))}/>
          </label>
          <label>Supply (whole units)
            <input className="input" type="number" min={0} value={supply} onChange={e=>setSupply(parseInt(e.target.value||'0'))}/>
          </label>
        </div>
        <label>Metadata URI (IPFS/Arweave JSON)
          <input className="input" placeholder="ipfs://..." value={uri} onChange={e=>setUri(e.target.value)}/>
        </label>
        <div style={{display:'flex', gap:8, alignItems:'center'}}>
          <button className="button" disabled={busy || !wallet.connected} onClick={run}>
            {busy ? 'Running...' : 'Run Bundler'}
          </button>
          <button className="button" disabled={busy || !wallet.connected} onClick={airdrop}>Airdrop 1 SOL (devnet)</button>
        </div>
        {mintPubkey && (
          <div className="card" style={{marginTop:8}}>
            <div><strong>Mint:</strong> {mintPubkey.toBase58()}</div>
            <div style={{opacity:.8}}>Добавьте в Phantom через "Manage Token -> Add Token" по адресу.</div>
          </div>
        )}
        <div className="card" style={{marginTop:8}}>
          <div style={{opacity:.8}}>
            Примечание: создание пула ликвидности (Raydium/иное) не входит в этот минимальный бандлер.
            Сначала создайте токен и пополните кошелёк; затем добавляйте ликвидность через выбранную платформу.
          </div>
        </div>
      </div>
    </div>
  )
}

export default AppWrapper
