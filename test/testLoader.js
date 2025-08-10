const Loader = require('../');
const wait = require('pwait');
const expect = require('chai').expect;

const loader = new Loader('brand', async (key) => {
	await wait(1000);
	return { key };
}, {
	ttl: 30
});


const loader2 = new Loader('brand', async (obj) => {
	console.log('start loading', obj);
	await wait(1000);
	return obj;
}, {
	ttl: 30
});

const loader3 = new Loader('brand', async (a,b,c) => {
	console.log('start loading', a,b,c);
	await wait(1000);
	return [a,b,c];
}, {
	ttl: 30
});



describe('test loader', function() {

	this.timeout(600000);

	it('loader with number key', async () => {
		let r = await loader.load(999);
		expect(r.key).to.equal(999);
	});


	it('loader with string key', async () => {
		let r = await loader.load("abc");
		expect(r.key).to.equal("abc");
	});

	it('loader with object key', async () => {
		let r = await loader2.load({a:'A',b:'B'});
		expect(r.a).to.equal("A");
		expect(r.b).to.equal("B");
	});

	it('loader with more than 1 params', async () => {
		let r = await loader3.load(11,22,33);
		console.log('return', r);
		expect(r[0]).to.equal(11);
		expect(r[1]).to.equal(22);
		expect(r[2]).to.equal(33);
	});

});
