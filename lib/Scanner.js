var debug = require('debug')(require('../package.json').name);
var path = require('path');
var fs = require('fs');
var _ = require('lodash');
var flatten = require('flat');
var exec = require('child_process').exec;



var Scanner = function(spec) {
  debug('new instance', spec);

  var obj = {}; //inheritance: var obj = GenericScanner(spec) || {};

  //spec = spec || {};

  var scan = function(dir, done) {
    debug('scanning', dir);

    var apiSpec = { executable: {} };

    var metadataFile = path.join(dir, 'metadata.json');
    var tempRb = path.join(dir, 'temp.rb');
    var attrFiles = [];

    var metadata = {};

    // Get recipes and attributes from metadata
    if (fs.existsSync(metadataFile)) {
      metadata = JSON.parse(fs.readFileSync(metadataFile));
      metadata.attributes = metadata.attributes || {};
      metadata.recipes = metadata.recipes || {};

      apiSpec.executable.type = 'chef_cookbook';
      apiSpec.executable.name = metadata.name + ' cookbook';
      apiSpec.executable.cookbook_name = metadata.name;
      apiSpec.executable.docs = 'API parameters are directly mapped to cookbook attributes, ' +
                                'e.g., "foo/bar" is mapped to "node[\'foo\'][\'foo\']". ' +
                                'Check out the API specification and the README file of the ' +
                                'executable to find out which parameters are supported.';
    } else {
      //TODO: generate metadata.json from metadata.rb file, if JSON variant doesn't exist using the following command: knife cookbook metadata mysql -o /cookbooks
      return done();
    }

    if (fs.existsSync(path.join(dir, 'README.md'))) {
      apiSpec.executable.readme = 'README.md';
    }

    // Get more recipes from Ruby files
    _.each(fs.readdirSync(path.join(dir, 'recipes')), function(file) {
      if (fs.statSync(path.join(dir, 'recipes', file)).isDirectory()) return;

      var name = metadata.name + '::' + path.basename(file, '.rb');

      if (file === 'default.rb') var name = metadata.name;

      metadata.recipes[name] = metadata.recipes[name] || '';
    });

    // Get attribute files
    var attrDir = path.resolve(dir, 'attributes');

    if (fs.existsSync(path.resolve(attrDir, 'default.rb')))
      attrFiles.push(path.resolve(attrDir, 'default.rb'));

    _.each(fs.readdirSync(attrDir), function(file) {
      if (fs.statSync(path.join(attrDir, file)).isDirectory() ||
          path.extname(file) !== '.rb' ||
          file === 'default.rb') return;

      attrFiles.push(path.resolve(attrDir, file));
    });

    // Get more attributes from Ruby files
    var rubyBin = process.env.RUBY_BIN || 'ruby'; //TODO: use opal / node-opal packaged instead

    var mashNew = 'Mash.new { |mash, key| mash[key] = ' +
                  'Mash.new { |mash, key| mash[key] = ' +
                  'Mash.new { |mash, key| mash[key] = ' +
                  'Mash.new { |mash, key| mash[key] = ' +
                  'Mash.new { |mash, key| mash[key] = ' +
                  'Mash.new { |mash, key| mash[key] = ' +
                  'Mash.new { |mash, key| mash[key] = Mash.new } } } } } } }';

    //mashNew = 'Mash.new';

    var mashClass = path.resolve(__dirname, '..', 'chef', 'mash.rb');

    var tpl = [ 'cat <%= mashClass %> >> <%= tempRb %> &&',
                'echo "require \'json\'\n',
                //'Mash = Hash\n',
                'default = node = kernel = <%= mashNew %>\n',
                'def node.platform?(arg)\nend\n',
                'def node.platform_family?(arg)\nend\n',
                //'node = <%= mashNew %>\n',
                '<%= name %> = <%= mashNew %>\n',
                '<% if (platform) { %> node[\'platform\'] = \'<%= platform %>\'\n <% } %>',
                '<% if (platformVersion) { %> node[\'platform_version\'] = \'<%= platformVersion %>\'\n <% } %>',
                '" >> <%= tempRb %> &&',
                '<% _.forEach(attrFiles, function(file) { print("cat " + file + " >> " + tempRb + " && "); }); %>',
                'echo "\nputs default.to_json" >> <%= tempRb %> &&',
                '<%= rubyBin %> <%= tempRb %> &&',
                'rm <%= tempRb %>' ].join(' ');

    var cmd = _.template(tpl, { name: metadata.name,
                                mashClass: mashClass,
                                mashNew: mashNew,
                                platform: process.env.DEFAULT_PLATFORM || 'ubuntu',
                                platformVersion: process.env.DEFAULT_PLATFORM_VERSION || '14.04',
                                tempRb: tempRb,
                                attrFiles: attrFiles,
                                rubyBin: rubyBin });

    debug('cmd', cmd);

    var ruby = exec(cmd, function(err, stdout, stderr) {
      debug('err', err);
      debug('stderr', stderr);
      debug('stdout', stdout);

      if (err && err.code != 0) {
        console.error('Warning: Cannot read additional cookbook attributes file.');
      } else {
        var attributes = flatten(JSON.parse(stdout.replace(/(\r\n|\n|\r)/gm, '')), { delimiter: '/', safe: true });

        _.each(attributes, function(val, key) {
          if (metadata.attributes[key] ||
              key === 'platform' ||
              key === 'platform_version') return;

          var type = 'unknown';

          if (_.isNumber(val)) type = 'number';
          else if (_.isBoolean(val)) type = 'boolean';
          else if (_.isString(val)) type = 'string';
          else if (_.isArray(val)) type = 'array';

          metadata.attributes[key] = { default: val, type: type };
        });
      }

      apiSpec.parameters = {};

      if (!_.isEmpty(metadata.attributes)) {
        apiSpec.parameters = metadata.attributes;

        _.each(apiSpec.parameters, function(param, name) {
          param.mapping = 'cookbook_attribute';
        });
      }

      apiSpec.parameters.run_list = {
        type: 'array',
        description: 'Available recipes: ',
        mapping: 'run_list',
        schema: null
      };

      var sep = '';
      _.each(metadata.recipes, function(desc, name) {
        apiSpec.parameters.run_list.description += sep + 'recipe[' + name + ']';

        if (!_.isEmpty(desc))
          apiSpec.parameters.run_list.description += ' (' + desc + ')';

        sep = ', ';
      });

      var recipeNames = _.keys(metadata.recipes);

      if (_.contains(recipeNames, metadata.name)) {
        apiSpec.parameters.run_list.default = [ 'recipe[' + metadata.name + ']' ]
      } else {
        apiSpec.parameters.run_list.default = [ 'recipe[' + _.first(recipeNames) + ']' ]
      }

      done(null, apiSpec);
    });
  };

  obj.scan = scan;

  return obj;
};



module.exports = Scanner;
