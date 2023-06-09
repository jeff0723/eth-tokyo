import Head from 'next/head';
import Image from 'next/image';
import react from 'react'
import { Inter } from 'next/font/google';
import { useCallback, useEffect, useState } from 'react';
import { LitNodeClient } from '@lit-protocol/lit-node-client';
import Safe, { SafeFactory, SafeAccountConfig } from '@safe-global/protocol-kit'
import googleLogo from '../assets/google-logo.png'
import { BigNumber, ethers, Transaction, utils } from 'ethers';
import {
  getLoginUrl,
  isSignInRedirect,
  handleSignInRedirect,
} from '@/utils/auth';
import {
  fetchPKPs,
  mintPKP,
  pollRequestUntilTerminalState,
} from '@/utils/relay';
import { useRouter } from 'next/router';
import { SafeAuthKit } from '@/auth-kit/SafeAuthKit';
import { LitAuthAdapter } from '@/auth-kit/packs/web3auth/LitAuthAdapter';
import { PKP } from '@/types/pkp';
import { Box, Button, Modal, TextField, Typography } from '@mui/material';
import { EthersAdapter } from '@safe-global/protocol-kit'
import { ethRequestHandler, } from '@lit-protocol/pkp-ethers'
import { ETHTxRes } from '@lit-protocol/pkp-ethers/src/lib/pkp-ethers-types';
import { headers } from '../../next.config';
import { EIP712_SAFE_TX_TYPE, SafeDomainData, SafeTransaction } from '@/types/eip712safe';
import { arrayify } from 'ethers/lib/utils';
import { buildSignatureBytes, SafeSignature } from '@/utils/buildtx';
import styled from 'styled-components';
import toast from 'react-hot-toast';
import { CHAIN_ID, RPC_URL } from '../../app_config';

const inter = Inter({ subsets: ['latin'] });

const REDIRECT_URI =
  process.env.NEXT_PUBLIC_REDIRECT_URI || 'http://localhost:3000';

const Views = {
  SIGN_IN: 'sign_in',
  FETCHING: 'fetching',
  FETCHED: 'fetched',
  MINTING: 'minting',
  MINTED: 'minted',
  CREATING_SESSION: 'creating_session',
  SESSION_CREATED: 'session_created',
  ERROR: 'error',
  HANDLE_REDIRECT: 'handle_redirect',

};

const GoogleSignInButton = styled.button`
  background-color: #fff;
  border: none;
  border-radius: 4px;
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  font-weight: bold;
  height: 40px;
  padding: 8px 16px;
  transition: background-color 0.3s ease-in-out;
  &:hover {
    background-color: #eee;
  }

  &:active {
    background-color: #ddd;
  }
`;

const GradientText = styled.span`
  background-image: linear-gradient(to right, #4285F4, #34A853, #FBBC05, #EA4335);
  background-clip: text;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
`
const PKPButton = styled.button`
  background-color: #ff9e5c;
  color: #fff;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 16px;
  padding: 12px 24px;
  transition: background-color 0.3s ease-in-out;

  &:hover {
    background-color: #ff8a3d;
  }

  &:active {
    background-color: #ff7a2e;
  }
`;

const MintPKPButton = styled.button`
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 16px;
  padding: 12px 24px;
  color: #000;
  background-color: #fff;
  transition: background-color 0.3s ease-in-out;
`
const ActionButtonContainer = styled.div`
  display: flex;
  justify-content: center;
  gap: 16px;
`;

const ActionButton = styled.button`
  background-color: #12ff80;
  color: #000;
  border: none;
  border-radius: 4px;
  padding: 12px 24px;
  font-size: 16px;
  font-weight: bold;
  cursor: pointer;
  transition: background-color 0.3s ease-in-out;
  
  &:hover {
    background-color: #0edc6f;
  }
  
  &:active {
    background-color: #0dbf62;
  }
`;
const GoogleMintPKPPage = () => {
  console.log("RPC_URL: ", RPC_URL)
  const router = useRouter();
  const [view, setView] = useState(Views.SIGN_IN);
  const [error, setError] = useState();

  const [litNodeClient, setLitNodeClient] = useState<LitNodeClient>();
  const [googleIdToken, setGoogleIdToken] = useState<string>();
  const [pkps, setPKPs] = useState<PKP[]>([]);
  const [currentPKP, setCurrentPKP] = useState<PKP>();
  const [sessionSigs, setSessionSigs] = useState();

  const [message, setMessage] = useState('Free the web!');
  const [signature, setSignature] = useState(null);
  const [recoveredAddress, setRecoveredAddress] = useState(null);
  const [verified, setVerified] = useState(false);
  const [safeAuth, setSafeAuth] = useState<SafeAuthKit<LitAuthAdapter>>()
  const [isCreateSafeModalOpen, setCreateSafeModalOpen] = useState(false)
  const [isSignSafeTransactionModalOpen, setSignSafeTransactionModalOpen] = useState(false)
  const [address1, setAddress1] = useState('')
  const [address2, setAddress2] = useState('')

  const [domainData, setDomainData] = useState<SafeDomainData>()
  const [safeTypeData, setSafeTypeData] = useState<SafeTransaction>()
  const [safeSignature, setSafeSignature] = useState<string>()

  const [firstSignerSignature, setFirstSignerSignature] = useState<SafeSignature>()

  console.log("sessionSigs: ", sessionSigs)
  /**
   * Handle redirect from Lit login server
   */
  const handleRedirect = useCallback(async () => {
    setView(Views.HANDLE_REDIRECT);
    try {
      // Get Google ID token from redirect callback
      const googleIdToken = handleSignInRedirect(REDIRECT_URI);
      setGoogleIdToken(googleIdToken);

      // Fetch PKPs associated with Google account
      setView(Views.FETCHING);
      const pkps = await fetchGooglePKPs(googleIdToken);
      if (pkps.length > 0) {
        setPKPs(pkps);
      }
      setView(Views.FETCHED);
    } catch (err) {
      setError(err);
      setView(Views.ERROR);
    }

    // Clear url params once we have the Google ID token
    // Be sure to use the redirect uri route
    router.replace('/', undefined, { shallow: true });
  }, [router]);

  /**
   * Mint a new PKP for the authorized Google account
   */
  async function mint() {
    setView(Views.MINTING);

    try {
      // Mint new PKP
      const newPKP = await mintGooglePKP(googleIdToken);

      // Add new PKP to list of PKPs

      setPKPs([...pkps, newPKP]);

      setView(Views.MINTED);
      setView(Views.CREATING_SESSION);

      // Get session sigs for new PKP
      await createSession(newPKP);
    } catch (err) {
      setError(err);
      setView(Views.ERROR);
    }
  }

  /**
   * Generate session sigs for current PKP
   *
   * @param {Object} PKP - PKP object
   */
  async function createSession(pkp) {
    if (!litNodeClient) return
    setView(Views.CREATING_SESSION);

    try {
      // Create session with new PKP
      const authMethods = [
        {
          authMethodType: 6,
          accessToken: googleIdToken,
        },
      ];
      const authNeededCallback = getDefaultAuthNeededCallback(
        authMethods,
        pkp.publicKey
      );

      // Get session signatures
      const sessionSigs = await litNodeClient.getSessionSigs({
        chain: 'ethereum',
        resources: [`litAction://*`],
        authNeededCallback: authNeededCallback,
      });
      setCurrentPKP(pkp);
      setSessionSigs(sessionSigs);

      setView(Views.SESSION_CREATED);
    } catch (err) {
      setError(err);
      setView(Views.ERROR);
    }
  }

  async function signSafeTransactionLitAction(toSign: Uint8Array) {
    if (!litNodeClient) return
    if (!sessionSigs) return
    if (!currentPKP) return
    console.log('start lit action')
    const litActionCode = `
    const go = async () => {
      // this requests a signature share from the Lit Node
      // the signature share will be automatically returned in the response from the node
      // and combined into a full signature by the LitJsSdk for you to use on the client
      // all the params (toSign, publicKey, sigName) are passed in from the LitJsSdk.executeJs() function
      const sigShare = await LitActions.signEcdsa({ toSign, publicKey, sigName });

    };
    go();
  `;
    const results = await litNodeClient.executeJs({
      code: litActionCode,
      sessionSigs: sessionSigs,
      jsParams: {
        toSign: toSign,
        publicKey: currentPKP.publicKey,
        sigName: 'sig1',
      },
    });
    console.log(results)
    const _signature = results.signatures['sig1'].signature
    console.log('pkp wallet signature: ', _signature)
    setSafeSignature(_signature)
    return _signature


  }
  /**
   * Sign a message with current PKP
   */
  async function signMessage() {
    try {
      const toSign = ethers.utils.arrayify(ethers.utils.hashMessage(message));
      const litActionCode = `
        const go = async () => {
          // this requests a signature share from the Lit Node
          // the signature share will be automatically returned in the response from the node
          // and combined into a full signature by the LitJsSdk for you to use on the client
          // all the params (toSign, publicKey, sigName) are passed in from the LitJsSdk.executeJs() function
          const sigShare = await LitActions.signEcdsa({ toSign, publicKey, sigName });

        };
        go();
      `;
      // Sign message
      const results = await litNodeClient.executeJs({
        code: litActionCode,
        sessionSigs: sessionSigs,
        jsParams: {
          toSign: toSign,
          publicKey: currentPKP.publicKey,
          sigName: 'sig1',
        },
      });
      // Get signature
      const result = results.signatures['sig1'];
      const signature = ethers.utils.joinSignature({
        r: '0x' + result.r,
        s: '0x' + result.s,
        v: result.recid,
      });
      setSignature(signature);

      // Get the address associated with the signature created by signing the message
      const recoveredAddr = ethers.utils.verifyMessage(message, signature);
      setRecoveredAddress(recoveredAddr);
      // Check if the address associated with the signature is the same as the current PKP
      const verified =
        currentPKP.ethAddress.toLowerCase() === recoveredAddr.toLowerCase();
      setVerified(verified);
    } catch (err) {
      setError(err);
      setView(Views.ERROR);
    }
  }

  useEffect(() => {
    /**
     * Initialize LitNodeClient
     */
    async function initLitNodeClient() {
      try {
        // Set up LitNodeClient
        const litNodeClient = new LitNodeClient({
          litNetwork: 'serrano',
          debug: false,
        });

        // Connect to Lit nodes
        await litNodeClient.connect();

        // Set LitNodeClient
        setLitNodeClient(litNodeClient);
      } catch (err) {
        setError(err);
        setView(Views.ERROR);
      }
    }

    if (!litNodeClient) {
      initLitNodeClient();
    }
  }, [litNodeClient]);

  useEffect(() => {
    // Check if app has been redirected from Lit login server
    if (isSignInRedirect(REDIRECT_URI)) {
      handleRedirect();
    }
  }, [handleRedirect]);


  const createSafeAuthWallet = async () => {
    if (!sessionSigs) return
    if (!currentPKP) return
    const adapter = new LitAuthAdapter({
      pkpPubKey: currentPKP?.publicKey,
      authSig: sessionSigs
    })
    const safeAuthKit = await SafeAuthKit.init(adapter, {
      txServiceUrl: 'https://safe-transaction-goerli.safe.global'
    })
    await safeAuthKit.signIn()
    setSafeAuth(safeAuthKit)
  }


  const createSafe = async () => {
    if (!address1 || !address2) return
    if (!safeAuth) return
    try {
      const pkpwallet = safeAuth.getProvider()
      const owners = [address1, address2, safeAuth.safeAuthData.eoa]
      const threshold = 2
      const provider = pkpwallet.rpcProvider
      console.log('provider: ', provider)
      console.log('get rpc: ', pkpwallet.getRpc())
      // await pkpwallet.setRpc('https://eth-goerli.g.alchemy.com/v2/SKIuCInnDuvAmdTn6j-WCkiSAGZAiNUr')
      await pkpwallet.setRpc(RPC_URL)
      console.log('get rpc: ', pkpwallet.getRpc())
      const ethAdapter = new EthersAdapter({
        ethers,
        signerOrProvider: provider,
        // aiProtectorAddress: PROTECTOR,
      })
      const safeAccountConfig = {
        owners,
        threshold
      }

      const safeFactory = await SafeFactory.create({ ethAdapter: ethAdapter })
      const initializer = await safeFactory['encodeSetupCallData'](safeAccountConfig)
      const saltNonce = (Date.now() * 1000 + Math.floor(Math.random() * 1000)).toString()
      const from = safeAuth.safeAuthData.eoa;
      const to = '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2'; //goerli safe factory address

      const value = BigNumber.from(0);

      // pkp-ethers signer will automatically add missing fields (nonce, chainId, gasPrice, gasLimit)

      const abi = ["function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce)"];

      const safeFactoryAddress = '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2'  //goerli safe factory address
      const contract = new ethers.Contract(safeFactoryAddress, abi, provider);
      const safeSingleTonAddress = '0x3E5c63644E683549055b9Be8653de26E0B4CD36E'
      const unsignedTransaction = await contract.populateTransaction.createProxyWithNonce(safeSingleTonAddress, initializer, saltNonce)
      const data = unsignedTransaction.data;
      console.log("unsignedTransaction: ", unsignedTransaction)
      const txParams = {
        from,
        to,
        chainId: CHAIN_ID,
        value,
        data,
      };
      // console.log()

      // eth_signTransaction parameters
      // Transaction - Object
      // Reference: https://ethereum.github.io/execution-apis/api-documentation/#eth_signTransaction

      const txRes = await pkpwallet.handleRequest<ETHTxRes>({
        method: 'eth_sendTransaction',
        params: [txParams],
      });
      // await txRes.gi
      console.log("txRes: ", await txRes.wait())
    } catch (err) {
      toast.error('Error creating safe: ' + err.message + ' , Please try again later')
      console.log(err)
    }

    // fetch('/api/create-safe', {
    //   method: "POST",
    //   body: JSON.stringify(txParams),
    //   headers: {
    //     'Content-Type': 'application/json'
    //   }
    // })
    // console.log(txRes)

    // // Initialize Lit PKP Wallet
    // const wallet = new LitPKP({
    //   pkpPubKey: publicKey,
    //   controllerAuthSig: authSig,
    //   provider: 'https://rpc-mumbai.maticvigil.com',
    // });
    // await wallet.init();

    // // Sign eth_signTransaction request
    // const result = await wallet.signEthereumRequest(payload);
    // console.log('eth_signTransaction result', result);

  }
  const signSafeTransaction = async () => {

    console.log(domainData)
    console.log(safeTypeData)
    console.log(EIP712_SAFE_TX_TYPE)
    const structHash = ethers.utils._TypedDataEncoder.hash(domainData, EIP712_SAFE_TX_TYPE, safeTypeData)
    console.log("encoder hash:", structHash)
    console.log("encoder hash arrarify:", arrayify(structHash))
    const toSign = arrayify(structHash)
    const signature = await signSafeTransactionLitAction(toSign)
    const signatures: SafeSignature[] = [
      firstSignerSignature,
      {
        signer: safeAuth.safeAuthData.eoa,
        data: signature
      }
    ]
    console.log("safeSignature", signature)
    console.log("signatures: ", signatures)
    const signatureBytes = buildSignatureBytes(signatures)
    console.log('signatureBytes: ', signatureBytes)

    const pkpwallet = safeAuth.getProvider()
    const from = safeAuth.safeAuthData.eoa;
    const to = domainData.verifyingContract
    const value = BigNumber.from(0);
    const abi = ["function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures)"]
    const provider = pkpwallet.rpcProvider
    const contract = new ethers.Contract(to, abi, provider);
    // await pkpwallet.setRpc('https://eth-goerli.g.alchemy.com/v2/SKIuCInnDuvAmdTn6j-WCkiSAGZAiNUr')
    await pkpwallet.setRpc(RPC_URL)
    const unsignedTransaction = await contract.populateTransaction.execTransaction(safeTypeData.to, safeTypeData.value, safeTypeData.data, safeTypeData.operation, safeTypeData.safeTxGas, safeTypeData.baseGas, safeTypeData.gasPrice, safeTypeData.gasToken, safeTypeData.refundReceiver, signatureBytes)
    const data = unsignedTransaction.data;
    console.log("unsignedTransaction: ", unsignedTransaction)
    const txParams = {
      from,
      to,
      chainId: CHAIN_ID,
      value,
      data,
    };
    const txRes = await pkpwallet.handleRequest<ETHTxRes>({
      method: 'eth_sendTransaction',
      params: [txParams],
    });

    // await txRes.gi
    console.log("txRes: ", await txRes.wait())

  }
  console.log("safeAuth: ", safeAuth?.safeAuthData.eoa)
  console.log('safes:', safeAuth?.safeAuthData.safes)
  return (
    <div style={{ height: '100vh' }}>
      <Head>
        <title>Lit x Google OAuth x Safe</title>
        <meta
          name="description"
          content="Create a PKP with just a Google account"
        />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <main className={`${inter.className}`} style={{ display: 'flex', justifyContent: 'center', alignItems: "center", height: '100%' }}>
        {view === Views.ERROR && (
          <>
            <h1>Error</h1>
            <p>{error.message}</p>
            <button
              onClick={() => {
                if (sessionSigs) {
                  setView(Views.SESSION_CREATED);
                } else {
                  if (googleIdToken) {
                    setView(Views.FETCHED);
                  } else {
                    setView(Views.SIGN_IN);
                  }
                }
                setError(null);
              }}
            >
              Got it
            </button>
          </>
        )}
        {view === Views.SIGN_IN && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 36 }} >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <h1>Welcome to the SAFE x Google Auth x Lit</h1>
              <h2>{">>> Sign in with Lit"}</h2>
            </div>
            <button onClick={signInWithGoogle} style={{
              backgroundColor: '#fff',
              border: 'none',
              borderRadius: '4px',
              color: '#fff',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '16px',
              fontWeight: 'bold',
              height: '40px',
              padding: '8px 16px',
              transition: 'background-color 0.3s ease-in-out',
            }}>
              {/* <img src={googleLogo} /> */}

              <span
                style={{
                  backgroundImage: 'linear-gradient(to right, #4285F4, #34A853, #FBBC05, #EA4335)',
                  backgroundClip: 'text',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                }}
              >Sign in with Google</span>
            </button>
          </div>
        )}
        {view === Views.HANDLE_REDIRECT && (
          <>
            <h1>Verifying your identity...</h1>
          </>
        )}
        {view === Views.FETCHING && (
          <>
            <h1>Fetching your PKPs...</h1>
          </>
        )}
        {view === Views.FETCHED && (
          <>
            {pkps.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 36 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <h1>Select a PKP to continue</h1>
                  {/* Select a PKP to create session sigs for */}
                  <div style={{ display: 'flex', gap: 12 }}>
                    {pkps.map(pkp => (
                      <PKPButton
                        key={pkp.ethAddress}
                        onClick={async () => await createSession(pkp)}
                      >
                        {pkp.ethAddress}
                      </PKPButton>
                    ))}
                  </div>
                </div>
                <hr style={{ backgroundColor: "#fff" }}></hr>
                {/* Or mint another PKP */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <p>or mint another one:</p>
                  <MintPKPButton onClick={mint} style={{ display: 'flex', gap: 24, alignItems: 'center', justifyContent: 'center' }}>
                    <img src='/assets/lit-logo.png' width={42} height={42} />
                    Mint another PKP
                  </MintPKPButton>
                </div>
              </div>
            ) : (
              <>
                <h1>Mint a PKP to continue</h1>
                <button onClick={mint}>Mint a PKP</button>
              </>
            )}
          </>
        )}
        {view === Views.MINTING && (
          <>
            <h1>Minting your PKP...</h1>
          </>
        )}
        {view === Views.MINTED && (
          <>
            <h1>Minted!</h1>
          </>
        )}
        {view === Views.CREATING_SESSION && (
          <>
            <h1>Saving your session...</h1>
          </>
        )}
        {view === Views.SESSION_CREATED && (
          <div style={{ display: "flex", flexDirection: 'column', gap: 24 }}>
            <h1>Ready for the open web</h1>
            <div>
              <p>Your currenct PKP:</p>
              <p>{currentPKP.ethAddress}</p>
            </div>
            <hr></hr>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p>Sign this message with your PKP:</p>
              <p>{message}</p>
              <ActionButtonContainer >
                <ActionButton onClick={signMessage}>Sign message</ActionButton>
                <ActionButton onClick={createSafeAuthWallet}>Connect safe auth kit</ActionButton>
                <ActionButton onClick={() => setCreateSafeModalOpen(true)}>Create safe</ActionButton>
                <ActionButton onClick={() => setSignSafeTransactionModalOpen(true)}>Sign safe transaction</ActionButton>
                {/* <ActionButton onClick={() => {
                  toast.error('error message, please try it again')
                }}>Error</ActionButton> */}
              </ActionButtonContainer>
              <Modal
                open={isCreateSafeModalOpen}
                onClose={() => { setCreateSafeModalOpen(false) }}
                aria-labelledby="modal-modal-title"
                aria-describedby="modal-modal-description"
              >
                <Box sx={
                  {
                    position: 'absolute' as 'absolute',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    width: 400,
                    bgcolor: 'background.paper',
                    border: '2px solid #000',
                    boxShadow: 24,
                    borderRadius: 8,
                    p: 4,
                  }
                }>
                  <Typography id="modal-modal-title" variant="h6" component="h2" sx={{ color: '#000' }}>
                    Input your owner address
                  </Typography>
                  <div style={{ dispay: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ dispay: 'flex', flexDirection: 'column', gap: 6 }}>
                      <Typography sx={{ color: '#000', marginTop: '12px' }}>Regular wallet</Typography>
                      <div style={{ marginTop: '12px' }}>

                        <TextField label='Owner 1' hiddenLabel sx={{ width: '100%' }} value={address1} onChange={(e) => setAddress1(e.target.value)} />
                      </div>
                      <div style={{ marginTop: '12px' }}>
                        <TextField label='Owner 2' hiddenLabel sx={{ width: '100%' }} value={address2} onChange={(e) => setAddress2(e.target.value)} />
                      </div>
                    </div>
                    <Typography sx={{ color: '#000', marginTop: '12px' }}>Social wallet</Typography>
                    <div style={{ marginTop: '12px' }}>
                      <TextField label='Owner 3' hiddenLabel value={safeAuth?.safeAuthData?.eoa} sx={{ width: '100%' }} />
                    </div>
                  </div>
                  <ActionButton style={{ marginTop: '32px', width: '100%' }} onClick={createSafe}>Create Button</ActionButton>
                </Box>
                {/* <Button >Create Safe</Button> */}

              </Modal>
              <Modal sx={{ overflow: 'scroll' }} open={isSignSafeTransactionModalOpen} onClose={() => { setSignSafeTransactionModalOpen(false) }} aria-labelledby="modal-modal-title" aria-describedby="modal-modal-description">
                <Box sx={
                  {
                    position: 'absolute' as 'absolute',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    width: 400,
                    height: 700,
                    bgcolor: 'background.paper',
                    border: '2px solid #000',
                    boxShadow: 24,
                    p: 4,
                    borderRadius: 8,
                    overflow: 'scroll'
                  }
                }>

                  <Typography id="modal-modal-title" variant="h6" component="h2" sx={{ color: '#000' }}>
                    Sign your safe transaction
                  </Typography>
                  <div style={{ dispay: 'flex', flexDirection: 'column', gap: 10 }}>
                    <Typography sx={{ color: '#000', marginTop: '12px' }}>Previous singer data</Typography>
                    <div>
                      <TextField label='first signer address' fullWidth onChange={(e) => setFirstSignerSignature({
                        ...firstSignerSignature,
                        signer: e.target.value
                      })}
                        value={firstSignerSignature?.signer}
                      />
                    </div>
                    <div>
                      <TextField label='first signer sig' fullWidth onChange={(e) => setFirstSignerSignature({
                        ...firstSignerSignature,
                        data: e.target.value
                      })}
                        value={firstSignerSignature?.data}
                      />
                    </div>

                    <Typography sx={{ color: '#000', marginTop: '12px' }}>Domain data</Typography>
                    <div>
                      <TextField label='verifying contract' fullWidth onChange={(e) => setDomainData({
                        ...domainData,
                        verifyingContract: e.target.value
                      })}
                        value={domainData?.verifyingContract}
                      />
                    </div>
                    <div>
                      <TextField label='chainId' fullWidth onChange={(e) => setDomainData({
                        ...domainData,
                        chainId: Number(e.target.value)
                      })}
                        value={domainData?.chainId} />
                    </div>
                    <Typography sx={{ color: '#000' }}>Safe transaction data</Typography>
                    <div>
                      <TextField label='to' fullWidth onChange={(e) => setSafeTypeData({
                        ...safeTypeData,
                        to: e.target.value
                      })}
                        value={safeTypeData?.to} />
                    </div>
                    <div>
                      <TextField label='value' fullWidth onChange={(e) => setSafeTypeData({
                        ...safeTypeData,
                        value: e.target.value
                      })}
                        value={safeTypeData?.value} />
                    </div>
                    <div>
                      <TextField label='data' fullWidth onChange={(e) => setSafeTypeData({
                        ...safeTypeData,
                        data: e.target.value
                      })}
                        value={safeTypeData?.data}
                      />
                    </div>
                    <div>
                      <TextField label='operation' fullWidth onChange={(e) => setSafeTypeData({
                        ...safeTypeData,
                        operation: Number(e.target.value)
                      })}
                        value={safeTypeData?.operation}
                      />
                    </div>
                    <div>
                      <TextField label='safeTxGas' fullWidth onChange={(e) => setSafeTypeData({
                        ...safeTypeData,
                        safeTxGas: Number(e.target.value)
                      })}
                        value={safeTypeData?.safeTxGas}
                      />
                    </div>
                    <div>
                      <TextField label='baseGas' fullWidth onChange={(e) => setSafeTypeData({
                        ...safeTypeData,
                        baseGas: Number(e.target.value)
                      })}
                        value={safeTypeData?.baseGas}
                      />
                    </div>
                    <div>
                      <TextField label='gasPrice' fullWidth onChange={(e) => setSafeTypeData({
                        ...safeTypeData,
                        gasPrice: Number(e.target.value)
                      })}
                        value={safeTypeData?.gasPrice}
                      />
                    </div>
                    <div>
                      <TextField label='gasToken' fullWidth onChange={(e) => setSafeTypeData({
                        ...safeTypeData,
                        gasToken: e.target.value
                      })}
                        value={safeTypeData?.gasToken}
                      />
                    </div>
                    <div>
                      <TextField label='refundReceiver' fullWidth onChange={(e) => setSafeTypeData({
                        ...safeTypeData,
                        refundReceiver: e.target.value
                      })}
                        value={safeTypeData?.refundReceiver}
                      />
                    </div>
                    <div>
                      <TextField label='nonce' fullWidth fullWidth onChange={(e) => setSafeTypeData({
                        ...safeTypeData,
                        nonce: Number(e.target.value)
                      })}
                        value={safeTypeData?.nonce}
                      />
                    </div>
                    <Typography id="modal-modal-title" variant="h6" component="h2">
                      {safeSignature}
                    </Typography>
                  </div>
                  <ActionButton style={{ marginTop: '32px', width: '100%' }} onClick={signSafeTransaction}>Sign Safe Transaction</ActionButton>
                </Box>
              </Modal>

              {signature && (
                <div style={{ display: "flex", flexDirection: 'column', gap: 6 }}>
                  <h3>Your signature:</h3>
                  <p>{signature}</p>
                  <h3>Recovered address:</h3>
                  <p>{recoveredAddress}</p>
                  <h3>Verified:</h3>
                  <p>{verified ? 'true' : 'false'}</p>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

/**
 * Redirect user to the Google authorization page
 */
function signInWithGoogle() {
  // Get login url
  const loginUrl = getLoginUrl(REDIRECT_URI);
  // Redirect to login url
  window.location.assign(loginUrl);
}

/**
 * Fetch PKPs associated with the given Google account through the relay server
 *
 * @param {string} idToken - Google ID token
 *
 * @returns PKPs associated with Google account
 */
async function fetchGooglePKPs(idToken) {
  // Fetch PKPs associated with Google OAuth
  const body = JSON.stringify({
    idToken: idToken,
  });
  const fetchRes = await fetchPKPs(body);
  const { pkps } = fetchRes;
  if (!pkps) {
    throw new Error('Unable to fetch PKPs through relay server');
  }
  return pkps;
}

/**
 * Mint a PKP for the given Google account through the relay server
 *
 * @param {string} idToken - Google ID token
 *
 * @returns newly minted PKP
 */
async function mintGooglePKP(idToken) {
  // Mint a new PKP via relay server
  const body = JSON.stringify({
    idToken: idToken,
  });
  const mintRes = await mintPKP(body);
  const { requestId } = mintRes;
  if (!requestId) {
    throw new Error('Unable to mint PKP through relay server');
  }

  // Poll for status of minting PKP
  const pollRes = await pollRequestUntilTerminalState(requestId);
  if (!pollRes.pkpEthAddress || !pollRes.pkpPublicKey) {
    throw new Error('Unable to mint PKP through relay server');
  }
  const newPKP = {
    ethAddress: pollRes.pkpEthAddress,
    publicKey: pollRes.pkpPublicKey,
  };
  return newPKP;
}

/**
 * Default callback to prompt the user to authenticate with their PKP via non-wallet auth methods such as social login
 *
 * @param {AuthMethod[]} authMethods - Auth method array that includes the auth method type and data
 * @param {string} pkpPublicKey - Public key of the PKP
 *
 * @returns callback function
 */
function getDefaultAuthNeededCallback(authMethods, pkpPublicKey) {
  const defaultCallback = async ({
    chainId,
    resources,
    expiration,
    uri,
    litNodeClient,
  }) => {
    const sessionSig = await litNodeClient.signSessionKey({
      sessionKey: uri,
      authMethods: authMethods,
      pkpPublicKey: pkpPublicKey,
      expiration,
      resources,
      chainId,
    });
    return sessionSig;
  };

  return defaultCallback;
}

export default GoogleMintPKPPage