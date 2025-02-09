import chai, { expect } from 'chai';
import { ethers } from 'hardhat';
import { contract, given, then, when } from '@test-utils/bdd';
import { snapshot } from '@test-utils/evm';
import { DCAFeeManagerMock, DCAFeeManagerMock__factory, IDCAHub, IDCAHubPositionHandler, IERC20 } from '@typechained';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { duration } from 'moment';
import { behaviours, wallet } from '@test-utils';
import { IDCAFeeManager } from '@typechained/contracts/DCAFeeManager/DCAFeeManager';
import { FakeContract, smock } from '@defi-wonderland/smock';
import { BigNumber, BigNumberish, constants, utils } from 'ethers';

chai.use(smock.matchers);

contract('DCAFeeManager', () => {
  const TOKEN_A = '0x0000000000000000000000000000000000000010';
  const TOKEN_B = '0x0000000000000000000000000000000000000011';
  const MAX_SHARES = 10000;
  const SWAP_INTERVAL = duration(1, 'day').asSeconds();
  let DCAHub: FakeContract<IDCAHub>;
  let DCAFeeManager: DCAFeeManagerMock;
  let DCAFeeManagerFactory: DCAFeeManagerMock__factory;
  let erc20Token: FakeContract<IERC20>;
  let random: SignerWithAddress, superAdmin: SignerWithAddress, admin: SignerWithAddress;
  let superAdminRole: string, adminRole: string;
  let snapshotId: string;

  before('Setup accounts and contracts', async () => {
    [random, superAdmin, admin] = await ethers.getSigners();
    DCAHub = await smock.fake('IDCAHub');
    erc20Token = await smock.fake('IERC20');
    DCAFeeManagerFactory = await ethers.getContractFactory('contracts/mocks/DCAFeeManager/DCAFeeManager.sol:DCAFeeManagerMock');
    DCAFeeManager = await DCAFeeManagerFactory.deploy(superAdmin.address, [admin.address]);
    superAdminRole = await DCAFeeManager.SUPER_ADMIN_ROLE();
    adminRole = await DCAFeeManager.ADMIN_ROLE();
    snapshotId = await snapshot.take();
  });

  beforeEach(async () => {
    await snapshot.revert(snapshotId);
    DCAHub.platformBalance.reset();
    DCAHub.withdrawFromPlatformBalance.reset();
    DCAHub.withdrawSwappedMany.reset();
    DCAHub['deposit(address,address,uint256,uint32,uint32,address,(address,uint8[])[])'].reset();
    DCAHub.increasePosition.reset();
    DCAHub.terminate.reset();
    erc20Token.allowance.reset();
    erc20Token.approve.reset();
    erc20Token.transfer.reset();
  });

  describe('constructor', () => {
    when('super admin is zero address', () => {
      then('tx is reverted with reason error', async () => {
        await behaviours.deployShouldRevertWithMessage({
          contract: DCAFeeManagerFactory,
          args: [constants.AddressZero, []],
          message: 'ZeroAddress',
        });
      });
    });
    when('contract is initiated', () => {
      then('super admin is set correctly', async () => {
        const hasRole = await DCAFeeManager.hasRole(superAdminRole, superAdmin.address);
        expect(hasRole).to.be.true;
      });
      then('initial admins are set correctly', async () => {
        const hasRole = await DCAFeeManager.hasRole(adminRole, admin.address);
        expect(hasRole).to.be.true;
      });
      then('super admin role is set as admin for super admin role', async () => {
        const admin = await DCAFeeManager.getRoleAdmin(superAdminRole);
        expect(admin).to.equal(superAdminRole);
      });
      then('super admin role is set as admin for admin role', async () => {
        const admin = await DCAFeeManager.getRoleAdmin(adminRole);
        expect(admin).to.equal(superAdminRole);
      });
      then('max token total share is set correctly', async () => {
        expect(await DCAFeeManager.MAX_TOKEN_TOTAL_SHARE()).to.equal(MAX_SHARES);
      });
      then('swap interval is set to daily', async () => {
        expect(await DCAFeeManager.SWAP_INTERVAL()).to.equal(SWAP_INTERVAL);
      });
    });
  });

  describe('runSwapsAndTransferMany', () => {
    // Note: we can't test that the underlying function was called
    behaviours.shouldBeExecutableOnlyByRole({
      contract: () => DCAFeeManager,
      funcAndSignature: 'runSwapsAndTransferMany',
      params: () => [
        {
          allowanceTargets: [],
          swappers: [],
          swaps: [],
          swapContext: [],
          transferOutBalance: [],
        },
      ],
      addressWithRole: () => admin,
      role: () => adminRole,
    });
  });

  describe('withdrawFromPlatformBalance', () => {
    const RECIPIENT = wallet.generateRandomAddress();
    when('withdraw is executed', () => {
      const AMOUNT_TO_WITHDRAW = [{ token: TOKEN_A, amount: utils.parseEther('1') }];
      given(async () => {
        await DCAFeeManager.connect(admin).withdrawFromPlatformBalance(DCAHub.address, AMOUNT_TO_WITHDRAW, RECIPIENT);
      });
      then('hub is called correctly', () => {
        expect(DCAHub.withdrawFromPlatformBalance).to.have.been.calledOnce;
        const [amountToWithdraw, recipient] = DCAHub.withdrawFromPlatformBalance.getCall(0).args as [AmountToWithdraw[], string];
        expectAmounToWithdrawToBe(amountToWithdraw, AMOUNT_TO_WITHDRAW);
        expect(recipient).to.equal(RECIPIENT);
      });
    });
    behaviours.shouldBeExecutableOnlyByRole({
      contract: () => DCAFeeManager,
      funcAndSignature: 'withdrawFromPlatformBalance',
      params: () => [DCAHub.address, [], RECIPIENT],
      addressWithRole: () => admin,
      role: () => adminRole,
    });
  });

  describe('withdrawFromBalance', () => {
    const RECIPIENT = wallet.generateRandomAddress();
    when('withdraw is executed', () => {
      const AMOUNT_TO_WITHDRAW = utils.parseEther('1');
      given(async () => {
        await DCAFeeManager.connect(admin).withdrawFromBalance([{ token: erc20Token.address, amount: AMOUNT_TO_WITHDRAW }], RECIPIENT);
      });
      then('internal function is called correctly', async () => {
        const calls = await DCAFeeManager.sendToRecipientCalls();
        expect(calls).to.have.lengthOf(1);
        expect(calls[0].token).to.equal(erc20Token.address);
        expect(calls[0].amount).to.equal(AMOUNT_TO_WITHDRAW);
        expect(calls[0].recipient).to.equal(RECIPIENT);
        expect(await DCAFeeManager.sendBalanceOnContractToRecipientCalls()).to.be.empty;
      });
    });
    when('withdraw with max(uint256) is executed', () => {
      given(async () => {
        await DCAFeeManager.connect(admin).withdrawFromBalance([{ token: erc20Token.address, amount: constants.MaxUint256 }], RECIPIENT);
      });
      then('internal function is called correctly', async () => {
        const calls = await DCAFeeManager.sendBalanceOnContractToRecipientCalls();
        expect(calls).to.have.lengthOf(1);
        expect(calls[0].token).to.equal(erc20Token.address);
        expect(calls[0].recipient).to.equal(RECIPIENT);
        expect(await DCAFeeManager.sendToRecipientCalls()).to.be.empty;
      });
    });
    behaviours.shouldBeExecutableOnlyByRole({
      contract: () => DCAFeeManager,
      funcAndSignature: 'withdrawFromBalance',
      params: [[], RECIPIENT],
      addressWithRole: () => admin,
      role: () => adminRole,
    });
  });

  describe('withdrawFromPositions', () => {
    const RECIPIENT = wallet.generateRandomAddress();
    when('withdraw is executed', () => {
      const POSITION_SETS = [{ token: TOKEN_A, positionIds: [1, 2, 3] }];
      given(async () => {
        await DCAFeeManager.connect(admin).withdrawFromPositions(DCAHub.address, POSITION_SETS, RECIPIENT);
      });
      then('hub is called correctly', () => {
        expect(DCAHub.withdrawSwappedMany).to.have.been.calledOnce;
        const [positionSets, recipient] = DCAHub.withdrawSwappedMany.getCall(0).args as [PositionSet[], string];
        expectPositionSetsToBe(positionSets, POSITION_SETS);
        expect(recipient).to.equal(RECIPIENT);
      });
    });
    behaviours.shouldBeExecutableOnlyByRole({
      contract: () => DCAFeeManager,
      funcAndSignature: 'withdrawFromPositions',
      params: () => [DCAHub.address, [], RECIPIENT],
      addressWithRole: () => admin,
      role: () => adminRole,
    });
  });

  describe('fillPositions', () => {
    const AMOUNT_OF_SWAPS = 10;
    const FULL_AMOUNT = utils.parseEther('1');
    const DISTRIBUTION = [
      { token: TOKEN_A, shares: MAX_SHARES / 2 },
      { token: TOKEN_B, shares: MAX_SHARES / 2 },
    ];
    const POSITION_ID_TOKEN_A = 1;
    const POSITION_ID_TOKEN_B = 2;
    when('allowance is zero', () => {
      given(async () => {
        erc20Token.allowance.returns(0);
        await DCAFeeManager.connect(admin).fillPositions(
          DCAHub.address,
          [{ token: erc20Token.address, amount: FULL_AMOUNT, amountOfSwaps: AMOUNT_OF_SWAPS }],
          DISTRIBUTION
        );
      });
      then('full allowance is set', () => {
        expect(erc20Token.approve).to.have.been.calledOnceWith(DCAHub.address, constants.MaxUint256);
      });
    });
    when('allowance is not zero but less than needed', () => {
      given(async () => {
        erc20Token.allowance.returns(1);
        await DCAFeeManager.connect(admin).fillPositions(
          DCAHub.address,
          [{ token: erc20Token.address, amount: FULL_AMOUNT, amountOfSwaps: AMOUNT_OF_SWAPS }],
          DISTRIBUTION
        );
      });
      then('allowance is reset', () => {
        expect(erc20Token.approve).to.have.been.calledTwice;
        expect(erc20Token.approve).to.have.been.calledWith(DCAHub.address, 0);
        expect(erc20Token.approve).to.have.been.calledWith(DCAHub.address, constants.MaxUint256);
      });
    });
    when('there is no position created', () => {
      describe('and deposit fails', () => {
        given(async () => {
          erc20Token.allowance.returns(constants.MaxUint256);
          DCAHub['deposit(address,address,uint256,uint32,uint32,address,(address,uint8[])[])'].revertsAtCall(0);
          DCAHub['deposit(address,address,uint256,uint32,uint32,address,(address,uint8[])[])'].returnsAtCall(1, POSITION_ID_TOKEN_B);
          await DCAFeeManager.connect(admin).fillPositions(
            DCAHub.address,
            [{ token: erc20Token.address, amount: FULL_AMOUNT, amountOfSwaps: AMOUNT_OF_SWAPS }],
            DISTRIBUTION
          );
        });
        then('full amount is spent on last target token', () => {
          expect(DCAHub['deposit(address,address,uint256,uint32,uint32,address,(address,uint8[])[])']).to.have.been.calledTwice;
          expect(DCAHub['deposit(address,address,uint256,uint32,uint32,address,(address,uint8[])[])']).to.have.been.calledWith(
            erc20Token.address,
            TOKEN_B,
            FULL_AMOUNT,
            AMOUNT_OF_SWAPS,
            SWAP_INTERVAL,
            DCAFeeManager.address,
            []
          );
        });
        then('position is stored for the pair', async () => {
          const key = await DCAFeeManager.getPositionKey(erc20Token.address, TOKEN_B);
          expect(await DCAFeeManager.positions(key)).to.equal(POSITION_ID_TOKEN_B);
        });
        then('position is stored for the to token', async () => {
          const positions = await DCAFeeManager.positionsWithToken(TOKEN_B);
          expect(positions).to.have.lengthOf(1);
          expect(positions[0]).to.equal(POSITION_ID_TOKEN_B);
        });
        then('allowance is not set', () => {
          expect(erc20Token.approve).to.not.have.been.called;
        });
      });
      describe('and deposit works', () => {
        given(async () => {
          DCAHub['deposit(address,address,uint256,uint32,uint32,address,(address,uint8[])[])'].returnsAtCall(0, POSITION_ID_TOKEN_A);
          DCAHub['deposit(address,address,uint256,uint32,uint32,address,(address,uint8[])[])'].returnsAtCall(1, POSITION_ID_TOKEN_B);
          await DCAFeeManager.connect(admin).fillPositions(
            DCAHub.address,
            [{ token: erc20Token.address, amount: FULL_AMOUNT, amountOfSwaps: AMOUNT_OF_SWAPS }],
            DISTRIBUTION
          );
        });
        then('deposit with token A is made correctly', () => {
          expect(DCAHub['deposit(address,address,uint256,uint32,uint32,address,(address,uint8[])[])']).to.have.been.calledWith(
            erc20Token.address,
            TOKEN_A,
            FULL_AMOUNT.div(2),
            AMOUNT_OF_SWAPS,
            SWAP_INTERVAL,
            DCAFeeManager.address,
            []
          );
        });
        then('deposit with token B is made correctly', () => {
          expect(DCAHub['deposit(address,address,uint256,uint32,uint32,address,(address,uint8[])[])']).to.have.been.calledWith(
            erc20Token.address,
            TOKEN_B,
            FULL_AMOUNT.div(2),
            AMOUNT_OF_SWAPS,
            SWAP_INTERVAL,
            DCAFeeManager.address,
            []
          );
        });
        then('there were only two deposits made', () => {
          expect(DCAHub['deposit(address,address,uint256,uint32,uint32,address,(address,uint8[])[])']).to.have.been.calledTwice;
        });
        then('position is stored for the pair with token A', async () => {
          const key = await DCAFeeManager.getPositionKey(erc20Token.address, TOKEN_A);
          expect(await DCAFeeManager.positions(key)).to.equal(POSITION_ID_TOKEN_A);
        });
        then('position is stored for the pair with token B', async () => {
          const key = await DCAFeeManager.getPositionKey(erc20Token.address, TOKEN_B);
          expect(await DCAFeeManager.positions(key)).to.equal(POSITION_ID_TOKEN_B);
        });
        then('position is stored for token A', async () => {
          const positions = await DCAFeeManager.positionsWithToken(TOKEN_A);
          expect(positions).to.have.lengthOf(1);
          expect(positions[0]).to.equal(POSITION_ID_TOKEN_A);
        });
        then('position is stored for token B', async () => {
          const positions = await DCAFeeManager.positionsWithToken(TOKEN_B);
          expect(positions).to.have.lengthOf(1);
          expect(positions[0]).to.equal(POSITION_ID_TOKEN_B);
        });
      });
    });

    when('there is a position created', () => {
      given(async () => {
        await DCAFeeManager.setPosition(erc20Token.address, TOKEN_A, POSITION_ID_TOKEN_A);
        await DCAFeeManager.setPosition(erc20Token.address, TOKEN_B, POSITION_ID_TOKEN_B);
      });
      describe('and increase fails', () => {
        given(async () => {
          DCAHub.increasePosition.revertsAtCall(0);
          await DCAFeeManager.connect(admin).fillPositions(
            DCAHub.address,
            [{ token: erc20Token.address, amount: FULL_AMOUNT, amountOfSwaps: AMOUNT_OF_SWAPS }],
            DISTRIBUTION
          );
        });
        then('full amount is spent on last target token', () => {
          expect(DCAHub.increasePosition).to.have.been.calledTwice;
          expect(DCAHub.increasePosition).to.have.been.calledWith(POSITION_ID_TOKEN_B, FULL_AMOUNT, AMOUNT_OF_SWAPS);
        });
      });
      describe('and increase works', () => {
        given(async () => {
          await DCAFeeManager.connect(admin).fillPositions(
            DCAHub.address,
            [{ token: erc20Token.address, amount: FULL_AMOUNT, amountOfSwaps: AMOUNT_OF_SWAPS }],
            DISTRIBUTION
          );
        });
        then('increase with token A is made correctly', () => {
          expect(DCAHub.increasePosition).to.have.been.calledWith(POSITION_ID_TOKEN_A, FULL_AMOUNT.div(2), AMOUNT_OF_SWAPS);
        });
        then('increase with token B is made correctly', () => {
          expect(DCAHub.increasePosition).to.have.been.calledWith(POSITION_ID_TOKEN_B, FULL_AMOUNT.div(2), AMOUNT_OF_SWAPS);
        });
        then('there were only two increases made', () => {
          expect(DCAHub.increasePosition).to.have.been.calledTwice;
        });
      });
    });
    behaviours.shouldBeExecutableOnlyByRole({
      contract: () => DCAFeeManager,
      funcAndSignature: 'fillPositions',
      params: () => [DCAHub.address, [{ token: erc20Token.address, amount: FULL_AMOUNT, amountOfSwaps: AMOUNT_OF_SWAPS }], DISTRIBUTION],
      addressWithRole: () => admin,
      role: () => adminRole,
    });
  });

  describe('terminatePositions', () => {
    const RECIPIENT = wallet.generateRandomAddress();
    const POSITION_IDS = [1, 2];
    when('function is executed', () => {
      given(async () => {
        DCAHub.userPosition.returns(({ positionId }: { positionId: BigNumber }) => ({
          from: erc20Token.address,
          to: positionId.eq(1) ? TOKEN_A : TOKEN_B,
          swapInterval: constants.Zero,
          swapsExecuted: constants.Zero,
          swapped: constants.Zero,
          swapsLeft: constants.Zero,
          remaining: constants.Zero,
          rate: constants.Zero,
        }));
        await DCAFeeManager.setPosition(erc20Token.address, TOKEN_A, 1);
        await DCAFeeManager.setPosition(erc20Token.address, TOKEN_B, 2);
        await DCAFeeManager.connect(admin).terminatePositions(DCAHub.address, POSITION_IDS, RECIPIENT);
      });
      then('position 1 is terminated and deleted from fee manager', async () => {
        expect(DCAHub.terminate).to.have.been.calledWith(1, RECIPIENT, RECIPIENT);
        const positionKey = await DCAFeeManager.getPositionKey(erc20Token.address, TOKEN_A);
        expect(await DCAFeeManager.positions(positionKey)).to.equal(0);
      });
      then('position 2 is terminated and deleted from fee manager', async () => {
        expect(DCAHub.terminate).to.have.been.calledWith(2, RECIPIENT, RECIPIENT);
        const positionKey = await DCAFeeManager.getPositionKey(erc20Token.address, TOKEN_B);
        expect(await DCAFeeManager.positions(positionKey)).to.equal(0);
      });
      then('only two positions were terminated', () => {
        expect(DCAHub.terminate).to.have.been.calledTwice;
      });
    });
    behaviours.shouldBeExecutableOnlyByRole({
      contract: () => DCAFeeManager,
      funcAndSignature: 'terminatePositions',
      params: () => [DCAHub.address, [], RECIPIENT],
      addressWithRole: () => admin,
      role: () => adminRole,
    });
  });

  describe('availableBalances', () => {
    when('function is executed', () => {
      const PLATFORM_BALANCE = utils.parseEther('1');
      const FEE_MANAGER_BALANCE = utils.parseEther('2');
      let position1: IDCAHubPositionHandler.UserPositionStruct, position2: IDCAHubPositionHandler.UserPositionStruct;
      given(async () => {
        DCAHub.platformBalance.returns(PLATFORM_BALANCE);
        erc20Token.balanceOf.returns(FEE_MANAGER_BALANCE);
        position1 = positionWith(TOKEN_A, erc20Token.address, utils.parseEther('1'));
        position2 = positionWith(TOKEN_B, erc20Token.address, utils.parseEther('3'));
        DCAHub.userPosition.returns(({ positionId }: { positionId: BigNumber }) => (positionId.eq(1) ? position1 : position2));
        await DCAFeeManager.setPositionsWithToken(erc20Token.address, [1, 2]);
      });
      then('balances are returned correctly', async () => {
        const balances = await DCAFeeManager.availableBalances(DCAHub.address, [erc20Token.address]);
        expect(balances).to.have.lengthOf(1);
        expect(balances[0].token).to.equal(erc20Token.address);
        expect(balances[0].platformBalance).to.equal(PLATFORM_BALANCE);
        expect(balances[0].feeManagerBalance).to.equal(FEE_MANAGER_BALANCE);
        expect(balances[0].positions).to.have.lengthOf(2);
        expectUserPositionToBeEqual(balances[0].positions[0], position1, 1);
        expectUserPositionToBeEqual(balances[0].positions[1], position2, 2);
      });
    });

    function expectUserPositionToBeEqual(
      actual: IDCAFeeManager.PositionBalanceStructOutput,
      expected: IDCAHubPositionHandler.UserPositionStruct,
      positionId: BigNumberish
    ) {
      expect(actual.positionId).to.equal(positionId);
      expect(actual.from).to.equal(expected.from);
      expect(actual.to).to.equal(expected.to);
      expect(actual.swapped).to.equal(expected.swapped);
      expect(actual.remaining).to.equal(expected.remaining);
    }

    function positionWith(from: string, to: string, swapped: BigNumberish) {
      return {
        from,
        to,
        swapInterval: constants.Zero,
        swapsExecuted: constants.Zero,
        swapped,
        swapsLeft: constants.Zero,
        remaining: constants.Zero,
        rate: constants.Zero,
      };
    }
  });

  describe('revokeAllowances', () => {
    when('allowance is revoked', () => {
      given(async () => {
        await DCAFeeManager.connect(admin).revokeAllowances([{ spender: random.address, tokens: [erc20Token.address] }]);
      });
      then('revoke was called correctly', async () => {
        const calls = await DCAFeeManager.revokeAllowancesCalls();
        expect(calls).to.have.lengthOf(1);
        expect(calls[0]).to.have.lengthOf(1);
        expect((calls[0][0] as any).spender).to.equal(random.address);
        expect((calls[0][0] as any).tokens).to.eql([erc20Token.address]);
      });
    });
    behaviours.shouldBeExecutableOnlyByRole({
      contract: () => DCAFeeManager,
      funcAndSignature: 'revokeAllowances',
      params: [[]],
      addressWithRole: () => admin,
      role: () => adminRole,
    });
  });

  type AmountToWithdraw = { token: string; amount: BigNumberish };
  function expectAmounToWithdrawToBe(actual: AmountToWithdraw[], expected: AmountToWithdraw[]) {
    expect(actual).to.have.lengthOf(expected.length);
    for (let i = 0; i < actual.length; i++) {
      expect(actual[i].token).to.equal(expected[i].token);
      expect(actual[i].amount).to.equal(expected[i].amount);
    }
  }

  type PositionSet = { token: string; positionIds: BigNumberish[] };
  function expectPositionSetsToBe(actual: PositionSet[], expected: PositionSet[]) {
    expect(actual).to.have.lengthOf(expected.length);
    for (let i = 0; i < actual.length; i++) {
      expect(actual[i].token).to.equal(expected[i].token);
      expect(actual[i].positionIds).to.have.lengthOf(expected[i].positionIds.length);
      for (let j = 0; j < actual[i].positionIds.length; j++) {
        expect(actual[i].positionIds[j]).to.equal(expected[i].positionIds[j]);
      }
    }
  }
});
