const stackName = 'testnet_ctoken_monitor';
const comptrollerAddressSecretName = `${stackName}_comptrollerAddress`;
const explorerUrlSecretName = `${stackName}_explorerUrl`;
const pushoverWebhookSecretName = `${stackName}_pushoverWebhook`;
const pushoverTokenSecretName = `${stackName}_pushoverToken`;
const pushoverUserSecretName = `${stackName}_pushoverUser`;

/* eslint-disable import/no-extraneous-dependencies,import/no-unresolved */
const axios = require('axios');
const axiosRetry = require('axios-retry');
const ethers = require('ethers');

function condition(error) {
  const result = axiosRetry.isNetworkOrIdempotentRequestError(error);
  const rateLimit = (error.response.status === 429);
  return result || rateLimit;
}

// function to calculate the delay until the next request attempt
// returns a value specified in milliseconds
function retryDelayFunc(retryCount) {
  // 300 seconds total in Autotask execution to perform retries
  // #   time   attempt
  // 0 -   0s - initial request
  // 1 -  40s - first retry (40s delay from initial request)
  // 2 - 120s - second retry (80s delay from first retry)
  // 3 - 280s - third retry (160s delay from second retry)
  // this leaves 20s for the rest of the Autotask to execute, plus
  // whatever time each request takes
  const delay = (2 ** retryCount) * 20 * 1000;
  return delay;
}

axiosRetry(axios, {
  retries: 3,
  retryDelay: retryDelayFunc,
  retryCondition: condition,
});

// import the DefenderRelayProvider to interact with its JSON-RPC endpoint
const { DefenderRelayProvider } = require('defender-relay-client/lib/ethers');
/* eslint-enable import/no-extraneous-dependencies,import/no-unresolved */

const TOKEN_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];
const MAKER_TOKEN_ABI = [
  'function decimals() view returns (uint256)',
  'function symbol() view returns (bytes32)',
];
const CTOKEN_ABI = ['function underlying() view returns (address)'];

const makerTokenAddress = '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2'.toLowerCase();
const saiTokenAddress = '0x89d24A6b4CcB1B6fAA2625fE562bDD9a23260359'.toLowerCase();
const oddTokens = [makerTokenAddress, saiTokenAddress];
const cEtherAddress = '0xb7cdeF6521EB451D67fB72fd42460f57EdD11101'.toLowerCase();

// Define the address in the handler section
let comptrollerAddress;
const comptrollerAbi = [
  'function oracle() external view returns (address)',
  'function getAllMarkets() public view returns (address[] memory)'
];
const oracleAbi = ['function getUnderlyingPrice(address cToken) external view returns (uint)'];

async function getComptroller(provider) {
  // create an ethers.js Contract for the Comptroller contract
  const comptrollerContract = new ethers.Contract(
    comptrollerAddress,
    comptrollerAbi,
    provider,
  );

  return comptrollerContract;
}

async function getOracleContract(comptrollerContract, provider) {
  // get the oracle address
  const oracleAddress = await comptrollerContract.oracle();

  // create an ethers.js Contract for the Oracle contract
  const oracleContract = new ethers.Contract(
    oracleAddress,
    oracleAbi,
    provider,
  );

  return oracleContract;
}

async function getScaledTokenPrice(oracleContract, cTokenAddress) {
  // returned price is of the form
  //   scaledPrice = rawPrice * 1e36 / baseUnit
  // where baseUnit is the smallest denomination of a token per whole token
  // for example, for Ether, baseUnit = 1e18
  const scaledPrice = await oracleContract.getUnderlyingPrice(cTokenAddress);

  return scaledPrice;
}

async function getTokenSymbol(cTokenAddress, provider) {
  let symbol;
  if (cTokenAddress.toLowerCase() === cEtherAddress) {
    return 'ETH';
  }

  const cTokenContract = new ethers.Contract(
    cTokenAddress,
    CTOKEN_ABI,
    provider,
  );

  const underlyingTokenAddress = await cTokenContract.underlying();

  if (oddTokens.includes(underlyingTokenAddress.toLowerCase())) {
    const underlyingTokenContract = new ethers.Contract(
      underlyingTokenAddress,
      MAKER_TOKEN_ABI,
      provider,
    );

    const symbolBytes32 = await underlyingTokenContract.symbol();
    // need to convert symbol from bytes32 to string
    symbol = ethers.utils.parseBytes32String(symbolBytes32);
  } else {
    const underlyingTokenContract = new ethers.Contract(
      underlyingTokenAddress,
      TOKEN_ABI,
      provider,
    );
    symbol = await underlyingTokenContract.symbol();
  }

  return symbol;
}

function createPushoverMessageForOracleFailure(
  symbol,
  cTokenAddress
) {
  const message = `Oracle price for ${cTokenAddress.slice(0, 6)} (${symbol}) failed.`;

  return message;
}

async function postToPushover(url, token, user, explorerLink, message) {
  const method = 'post';
  const headers = {
    'Content-Type': 'application/json',
  };

  const urlTitle = 'View transaction';

  const data = { token, user, message };

  if (explorerLink !== undefined) {
    data.url = explorerLink;
    data.url_title = urlTitle;
  }

  const response = await axios({
    url,
    method,
    headers,
    data,
  });
  return response;
}

// eslint-disable-next-line func-names
exports.handler = async function (autotaskEvent) {
  // ensure that the autotaskEvent Object exists
  if (autotaskEvent === undefined) {
    throw new Error('autotaskEvent undefined');
  }

  const { secrets } = autotaskEvent;
  if (secrets === undefined) {
    throw new Error('secrets undefined');
  }

  // ensure that there is a PushoverUrl secret
  const pushoverUrl = secrets[pushoverWebhookSecretName];
  if (pushoverUrl === undefined) {
    throw new Error('pushoverUrl undefined');
  }

  const pushoverToken = secrets[pushoverTokenSecretName];
  if (pushoverToken === undefined) {
    throw new Error('pushoverToken undefined');
  }

  const pushoverUser = secrets[pushoverUserSecretName];
  if (pushoverUser === undefined) {
    throw new Error('pushoverUser undefined');
  }

  // ensure that there is a comptrollerAddress secret
  comptrollerAddress = secrets[comptrollerAddressSecretName];
  if (comptrollerAddress === undefined) {
    throw new Error('comptrollerAddress undefined');
  }

  const explorerUrl = secrets[explorerUrlSecretName];
  if (explorerUrl === undefined) {
    throw new Error('explorerUrl undefined');
  }

  // ensure that the alert key exists within the body Object
  const transactionHash = autotaskEvent?.request?.body?.hash;

  // use the relayer provider for JSON-RPC requests
  const provider = new DefenderRelayProvider(autotaskEvent);

  // create an ethers.js Contract for the Compound Oracle contract
  const comptrollerContract = await getComptroller(provider);
  const cTokenAddresses = await comptrollerContract.getAllMarkets();
  const oracleContract = await getOracleContract(comptrollerContract, provider);

  // create messages for Pushover
  const promises = cTokenAddresses.map(async (cTokenAddress) => {
    if (cTokenAddress === ethers.constants.AddressZero) {
      throw new Error('unable to get address for match reason');
    }

    const symbol = await getTokenSymbol(cTokenAddress, provider);

    // get the conversion rate for this token to USD
    const scaledPrice = await getScaledTokenPrice(oracleContract, cTokenAddress);

    // create pushever message if the underlying price is zero
    if (scaledPrice.isZero()) {
      return createPushoverMessageForOracleFailure(symbol, cTokenAddress);
    }
  });

  // wait for the promises to settle
  const messages = (await Promise.all(promises)).filter(x => x !== undefined);

  // construct the explorer transaction link
  const explorerLink = transactionHash !== undefined
    ? `${explorerUrl}${transactionHash}`
    : undefined

  // aggregate all of the messages into larger messages
  // but don't exceed 2000 characters per combined message
  const combinedMessages = [];
  let combinedMessage = '';
  messages.forEach((message, messageIndex) => {
    const nextMessage = message;

    // the extra '1' in this if statement is for the additional line break that will be added
    // to all lines except the last one
    if (combinedMessage.length + nextMessage.length + 1 > 2000) {
      // don't add the message to the current combined message, just put it in the Array
      combinedMessages.push(combinedMessage);
      // re-initialize the combined message for aggregating the next group of messages
      combinedMessage = '';
    }

    // concatenate the next message to the current combined message
    combinedMessage += nextMessage;
    if (messageIndex < (messages.length - 1)) {
      // add a newline character to create separation between the messages
      combinedMessage += '\n';
    } else {
      // add the last message to the Array of messages
      combinedMessages.push(combinedMessage);
    }
  });

  console.log(combinedMessages);
  await Promise.all(combinedMessages.map(
    (message) => postToPushover(pushoverUrl, pushoverToken, pushoverUser, explorerLink, message),
  ));

  return {};
};
