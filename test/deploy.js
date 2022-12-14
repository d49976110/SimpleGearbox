const { loadFixture, impersonateAccount } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require("chai");
const { parseUnits } = require("ethers/lib/utils");
const { ethers } = require("hardhat");

describe("Gear Box ", function () {
    let owner, addr1, binance;
    let uni,
        dieselToken,
        interestModel,
        poolService,
        priceOracle,
        creditFilter,
        accountFactory,
        creditManager,
        creditAccount;
    let referralCode = 0;
    let minAmount = parseUnits("1", 18);
    let maxAmount = parseUnits("1000", 18);
    let maxLeverage = parseUnits("4", 2); // 400 = x4
    let coinAmount = parseUnits("1000", 18);
    let addLiquidityAmount = parseUnits("100", 18);
    let removeLiquidityAmount = parseUnits("50", 18);
    let openCreditAccount = parseUnits("10", 18);
    let addCollateralAmount = parseUnits("1", 18);

    const treasuryAddress = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    const uniSwapV2Router = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
    const UniAddress = "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984";
    const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
    const CompAddress = "0xc00e94Cb662C3520282E6f5717214004A7f26888";
    const UniPriceFeed = "0x553303d460EE0afB37EdFf9bE42922D8FF63220e";
    const CompPriceFeed = "0xdbd020CAeF83eFd542f4De03e3cF0C28A4428bd5";
    const Binance = "0xF977814e90dA44bFA03b6295A0616a897441aceC";

    async function deployContractFixture() {
        // Contracts are deployed using the first signer/account by default
        [owner, addr1, addr2, ...addrs] = await ethers.getSigners();

        uni = await ethers.getContractAt("CoinA", UniAddress);
        comp = await ethers.getContractAt("CoinA", CompAddress);
        //imperson and transfer token to owner
        await impersonateAccount(Binance);
        binance = await ethers.getSigner(Binance);
        await uni.connect(binance).transfer(owner.address, coinAmount);
        await uni.connect(binance).transfer(addr1.address, coinAmount);

        const DieselToken = await ethers.getContractFactory("DieselToken");
        dieselToken = await DieselToken.deploy("Diesel Uniswap Token", "DUNI");

        const InterestModel = await ethers.getContractFactory("InterestRateModel");
        interestModel = await InterestModel.deploy();

        const PoolService = await ethers.getContractFactory("PoolService");
        poolService = await PoolService.deploy(
            treasuryAddress,
            uni.address,
            dieselToken.address,
            interestModel.address
        );

        const PriceOracle = await ethers.getContractFactory("PriceOracle");
        priceOracle = await PriceOracle.deploy();

        // add price feed
        let tokens = [UniAddress, CompAddress];
        let priceFeeds = [UniPriceFeed, CompPriceFeed];
        await priceOracle.addPriceFeed(tokens, priceFeeds);

        const CreditFilter = await ethers.getContractFactory("CreditFilter");
        creditFilter = await CreditFilter.deploy(priceOracle.address, uni.address);

        const AccountFactory = await ethers.getContractFactory("AccountFactory");
        accountFactory = await AccountFactory.deploy();

        const CreditManager = await ethers.getContractFactory("CreditManager");
        creditManager = await CreditManager.deploy(
            minAmount,
            maxAmount,
            maxLeverage,
            poolService.address,
            creditFilter.address,
            uniSwapV2Router,
            accountFactory.address
        );
        // todo creditManager set contract adapter
        await creditManager.setContractAdapter(uniSwapV2Router, true);

        // creditFilter connect creditManager & allow comp address
        await creditFilter.connectCreditManager(creditManager.address);
        await creditFilter.allowToken(CompAddress);

        // accountFactory setCreditManager
        await accountFactory.setCreditManager(creditManager.address);

        await poolService.connectCreditManager(creditManager.address);
        expect(await poolService.creditManagersCanBorrow(owner.address)).to.eq(false);
        expect(await poolService.creditManagersCanBorrow(creditManager.address)).to.eq(true);

        // transfer Dtoken owner to Poolservice
        await dieselToken.transferOwnership(poolService.address);
        expect(await dieselToken.owner()).to.eq(poolService.address);

        // approve
        await uni.approve(poolService.address, coinAmount);
        await uni.approve(creditManager.address, coinAmount);
        expect(await uni.balanceOf(owner.address)).to.eq(coinAmount);
        expect(await uni.allowance(owner.address, poolService.address)).to.eq(coinAmount);
    }

    describe("# Pool Service", async () => {
        before(async () => {
            await loadFixture(deployContractFixture);
        });

        it("add liquidity ", async function () {
            await poolService.addLiquidity(addLiquidityAmount, owner.address, referralCode);
            expect(await dieselToken.balanceOf(owner.address)).to.eq(addLiquidityAmount);
            expect(await uni.balanceOf(owner.address)).to.eq(coinAmount.sub(addLiquidityAmount));
        });

        it("remove liquidity", async () => {
            await poolService.removeLiquidity(removeLiquidityAmount, owner.address);
            expect(await dieselToken.balanceOf(owner.address)).to.eq(addLiquidityAmount.sub(removeLiquidityAmount));
        });
    });

    describe("# Credit Manager - swap & close", async () => {
        before(async () => {
            await loadFixture(deployContractFixture);
            await poolService.addLiquidity(addLiquidityAmount, owner.address, referralCode);
        });

        it("open credit account", async () => {
            await creditManager.openCreditAccount(openCreditAccount, owner.address, maxLeverage, referralCode);
            creditAccount = await creditManager.creditAccounts(owner.address);
            let [, balance, ,] = await creditFilter.getCreditAccountTokenById(creditAccount, 0);
            expect(balance).to.eq(openCreditAccount.mul(maxLeverage.add(100)).div(100)); // (max leverage + origin) / 100
        });

        it("executeOrder should revert : Not Allowed Token", async () => {
            const amountOutMin = parseUnits("7.5", 18);

            let uniBalance = await uni.balanceOf(creditAccount);
            let path = [owner.address, WETH, CompAddress];

            // executeOrder
            await expect(
                creditManager.executeOrder(owner.address, uniSwapV2Router, uniBalance, amountOutMin, path)
            ).to.be.revertedWith("Not Allowed Token");
        });

        it("executeOrder", async () => {
            const amountOutMin = parseUnits("7.5", 18);

            let uniBalance = await uni.balanceOf(creditAccount);
            let path = [UniAddress, WETH, CompAddress];

            // approve
            await creditManager.approve(uniSwapV2Router, UniAddress);

            // executeOrder
            expect(await comp.balanceOf(creditAccount)).to.eq(0);
            await creditManager.executeOrder(owner.address, uniSwapV2Router, uniBalance, amountOutMin, path);
            expect(await comp.balanceOf(creditAccount)).to.gt(amountOutMin);
        });

        it("add collateral", async () => {
            let beforeBalance = await uni.balanceOf(creditAccount);
            await creditManager.addCollateral(owner.address, UniAddress, addCollateralAmount);
            expect(await uni.balanceOf(creditAccount)).to.gt(beforeBalance);
        });

        it("close credit account", async () => {
            // at least get 9 tokens back
            const amountOutMin = parseUnits("9", 18);
            let balanceBefore = await uni.balanceOf(owner.address);

            let path = [
                [[ethers.constants.AddressZero, ethers.constants.AddressZero], 0],
                [[CompAddress, WETH, UniAddress], amountOutMin],
            ];
            await creditManager.closeCreditAccount(owner.address, path);

            let [, balance, ,] = await creditFilter.getCreditAccountTokenById(creditAccount, 0);
            expect(balance).to.eq(1);
            expect(await uni.balanceOf(owner.address)).to.gt(balanceBefore.add(amountOutMin));
        });
    });

    describe("# Credit Manager - repay", async () => {
        before(async () => {
            await loadFixture(deployContractFixture);
            await poolService.addLiquidity(addLiquidityAmount, owner.address, referralCode);
        });

        it("open credit account", async () => {
            await creditManager.openCreditAccount(openCreditAccount, owner.address, maxLeverage, referralCode);
            creditAccount = await creditManager.creditAccounts(owner.address);
            let [, balance, ,] = await creditFilter.getCreditAccountTokenById(creditAccount, 0);
            expect(balance).to.eq(openCreditAccount.mul(maxLeverage.add(100)).div(100));
        });

        it("swap from Uni to Comp", async () => {
            expect(await swapFromUniToComp())
                .to.emit(creditManager, "ExecuteOrder")
                .withArgs(owner.address, uniSwapV2Router);
        });

        it("repay uni to get comp back ", async () => {
            let beforeBalance = await comp.balanceOf(owner.address);
            await creditManager.repayCreditAccount(owner.address);
            expect(await comp.balanceOf(owner.address)).to.gt(beforeBalance);
        });
    });

    describe("# Credit Manager - liquidate", async () => {
        before(async () => {
            await loadFixture(deployContractFixture);
            await poolService.addLiquidity(addLiquidityAmount, owner.address, referralCode);
        });

        it("open credit account", async () => {
            await creditManager.openCreditAccount(openCreditAccount, owner.address, maxLeverage, referralCode);
            creditAccount = await creditManager.creditAccounts(owner.address);
            let [, balance, ,] = await creditFilter.getCreditAccountTokenById(creditAccount, 0);
            expect(balance).to.eq(openCreditAccount.mul(maxLeverage.add(100)).div(100));
        });

        it("swap many times let credit account can be liquidate", async () => {
            let healthFactor = 20000;

            while (healthFactor > 10000) {
                expect(await swapFromUniToComp())
                    .to.emit(creditManager, "ExecuteOrder")
                    .withArgs(owner.address, uniSwapV2Router);

                expect(await swapFromCompToUni())
                    .to.emit(creditManager, "ExecuteOrder")
                    .withArgs(owner.address, uniSwapV2Router);

                healthFactor = await creditFilter.calcCreditAccountHealthFactor(creditAccount);
            }
        });

        it("liquidate - addr1 to liquidate owner", async () => {
            let beforeBalance = await comp.balanceOf(addr1.address);

            // approve
            await uni.connect(addr1).approve(creditManager.address, ethers.constants.MaxUint256);
            await creditManager.connect(addr1).liquidateCreditAccount(owner.address, addr1.address, true);
            expect(await uni.balanceOf(addr1.address)).to.gt(beforeBalance);
        });
    });

    async function swapFromUniToComp() {
        let uniBalance = await uni.balanceOf(creditAccount);
        let path = [UniAddress, WETH, CompAddress];

        // approve
        await creditManager.approve(uniSwapV2Router, UniAddress);

        // executeOrder
        await creditManager.executeOrder(owner.address, uniSwapV2Router, uniBalance, 0, path);
    }

    async function swapFromCompToUni() {
        let compBalance = await comp.balanceOf(creditAccount);
        let path = [CompAddress, WETH, UniAddress];

        // approve
        await creditManager.approve(uniSwapV2Router, CompAddress);
        // swap
        await creditManager.executeOrder(owner.address, uniSwapV2Router, compBalance, 0, path);
    }
});
