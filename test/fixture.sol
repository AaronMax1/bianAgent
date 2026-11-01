pragma solidity ^0.6.12;
contract TestToken {
    string public symbol = "TEST";
    uint8 public decimals = 18;
    mapping(address=>uint256) public balanceOf;
    mapping(address=>mapping(address=>uint256)) public allowance;
    event Transfer(address indexed from,address indexed to,uint256 value);
    event Approval(address indexed owner,address indexed spender,uint256 value);
    function mint(address to,uint256 amount) public { balanceOf[to]+=amount; emit Transfer(address(0),to,amount); }
    function approve(address spender,uint256 amount) external returns(bool) { allowance[msg.sender][spender]=amount;emit Approval(msg.sender,spender,amount);return true; }
    function transferFrom(address from,address to,uint256 amount) external returns(bool) {
        require(allowance[from][msg.sender]>=amount,"allowance");require(balanceOf[from]>=amount,"balance");
        allowance[from][msg.sender]-=amount;balanceOf[from]-=amount;balanceOf[to]+=amount;emit Transfer(from,to,amount);return true;
    }
}
contract TestRouter {
    event Withdrawal(address indexed src,uint256 wad);
    receive() external payable {}
    function getAmountsOut(uint256 amount,address[] calldata path) external pure returns(uint256[] memory out) {
        require(path.length>=2,"path");out=new uint256[](path.length);out[0]=amount;
        for(uint i=1;i<path.length;i++)out[i]=out[i-1]*2;
    }
    function swapExactETHForTokens(uint256 minOut,address[] calldata path,address to,uint256 deadline) external payable returns(uint256[] memory out) {
        require(block.timestamp<=deadline,"expired");uint amount=msg.value*2;require(amount>=minOut,"slippage");
        TestToken(path[path.length-1]).mint(to,amount);out=new uint256[](2);out[0]=msg.value;out[1]=amount;
    }
    function swapExactTokensForTokens(uint256 amount,uint256 minOut,address[] calldata path,address to,uint256 deadline) external returns(uint256[] memory out) {
        require(block.timestamp<=deadline,"expired");uint result=path.length==2?amount*2:amount*4;require(result>=minOut,"slippage");
        TestToken(path[0]).transferFrom(msg.sender,address(this),amount);TestToken(path[path.length-1]).mint(to,result);
        out=new uint256[](2);out[0]=amount;out[1]=result;
    }
    function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amount,uint256 minOut,address[] calldata path,address to,uint256 deadline) external {
        require(block.timestamp<=deadline,"expired");uint result=path.length==2?amount*2:amount*4;require(result>=minOut,"slippage");
        TestToken(path[0]).transferFrom(msg.sender,address(this),amount);emit Withdrawal(address(this),result);payable(to).transfer(result);
    }
}
contract TestProject {
    uint256 public minted;
    event Minted(address indexed receiver,uint256 quantity);
    function mint(uint256 quantity) external { minted+=quantity;emit Minted(msg.sender,quantity); }
    function broken() external pure { require(false,"intentional revert"); }
}
