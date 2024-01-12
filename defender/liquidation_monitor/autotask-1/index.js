const stackName = 'oracle';
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

let comptrollerAddress;
let graphUrl;
let multicallAddress;

// Define the address in the handler section
const comptrollerAbi = [
  'function getAccountLiquidity(address account) external view returns (uint, uint, uint)'
];
const multicallAbi = [
  'function aggregate(tuple(address target, bytes callData)[] calls) external returns (uint256 blockNumber, bytes[] memory returnData)'
];

function getComptroller(provider) {
  // create an ethers.js Contract for the Comptroller contract
  const comptrollerContract = new ethers.Contract(
    comptrollerAddress,
    comptrollerAbi,
    provider,
  );

  return comptrollerContract;
}

async function getAccounts() {
  const res = await axios.post(
    graphUrl,
    {
      query: `{
            accounts(where: { hasBorrowed: true }) {
              id
              hasBorrowed
            }
          }`
    },
    {
      headers: {
        'Content-Type': 'application/json'
      }
    }
  );

  return res.data.data.accounts;
}

function getMulticallContract(provider) {
  const multicallContract = new ethers.Contract(
    multicallAddress,
    multicallAbi,
    provider,
  );

  return multicallContract;
}

async function getAccountShortfalls(multicallContract, comptrollerContract, accounts) {
  const calls = accounts.map(account => {
    return {
      target: comptrollerContract.address,
      callData: comptrollerContract.interface.encodeFunctionData('getAccountLiquidity', [account.id])
    }
  });

  const { returnData } = await multicallContract.callStatic.aggregate(calls);

  const shortfalls = returnData.map((data, index) => {
    const [err, , shortfall] = comptrollerContract.interface.decodeFunctionResult('getAccountLiquidity', data);

    if (err.gt(0)) {
      console.error(`Error getting liquidity for account ${accounts[index]}`);
    }

    return {
      account: accounts[index],
      shortfall: shortfall
    }
  });

  return shortfalls;
}

function createPushoverMessage(
  account,
  shortfall
) {
  const message = `Account ${account.slice(0, 6)} has a shortfall of ${shortfall}.`;

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

  ({ comptrollerAddress, graphUrl, multicallAddress } = process.env);

  if (comptrollerAddress === undefined) {
    throw new Error('comptrollerAddress undefined');
  }

  if (graphUrl === undefined) {
    throw new Error('graphUrl undefined');
  }

  if (multicallAddress === undefined) {
    throw new Error('multicallAddress undefined');
  }

  const { explorerUrl } = process.env;
  if (explorerUrl === undefined) {
    throw new Error('explorerUrl undefined');
  }

  // ensure that the alert key exists within the body Object
  const transactionHash = autotaskEvent?.request?.body?.hash;

  // use the relayer provider for JSON-RPC requests
  const provider = new DefenderRelayProvider(autotaskEvent);

  // get array of accounts that have borrowed from the comptroller
  const accounts = await getAccounts();

  const multicallContract = getMulticallContract(provider);
  const comptrollerContract = getComptroller(provider);

  // TODO: alert only on a new shortfall so duplicate alerts are not constantly pushed
  const shortfalls = await getAccountShortfalls(multicallContract, comptrollerContract, accounts);

  // create messages for Pushover
  const promises = shortfalls.map(async ({ shortfall, account }) => {
    // create pushever message if the account is in shortfall
    if (shortfall.gt(0)) {
      return createPushoverMessage(account, shortfall);
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
