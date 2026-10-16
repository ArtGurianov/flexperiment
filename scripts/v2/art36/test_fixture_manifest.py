import importlib.util,pathlib,unittest
spec=importlib.util.spec_from_file_location('fixture_manifest',pathlib.Path(__file__).with_name('fixture-manifest.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class ManifestBoundary(unittest.TestCase):
 def test_exact_single_fixture_and_route_not_live_stack(self):
  x=m.render('a'*32);s=x['compose']['services']['fixture'];self.assertEqual(set(x['compose']['services']),{'fixture'});self.assertNotIn('ports',s);self.assertNotIn('environment',s);self.assertEqual(s['restart'],'no');self.assertTrue(s['read_only']);self.assertEqual(s['networks'],['coolify']);self.assertEqual(s['cap_drop'],['ALL']);self.assertEqual(s['entrypoint'],['node','/opt/art36/provider-fixture.mjs']);self.assertTrue(all('/fixture-runtime/' in v and v.endswith(':ro') for v in s['volumes']))
  routers=x['route']['http']['routers'];self.assertEqual(len(routers),1);r=next(iter(routers.values()));self.assertEqual(r['rule'],'Host(`canary-api.flexperiment.ru`) && Method(`POST`) && Path(`/__art36/'+'a'*32+'/authorize`)');self.assertNotIn('PathPrefix',r['rule']);self.assertNotIn('/v1/kinescope',r['rule']);self.assertNotIn('webhooks',r['rule'])
 def test_untrusted_namespace_cannot_expand_route_or_mounts(self):
  for scope in ['',None,'a'*31,'A'*32,'../'*12,'a'*32+'`',{},'a'*32+'\n']:
   with self.subTest(scope=scope),self.assertRaises(ValueError):m.render(scope)
if __name__=='__main__':unittest.main()
