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

  //spec.entryPoint = spec.entryPoint || 'https://supermarket.getchef.com/api/v1/cookbooks';

  var scan = function(dir, done) {
    debug('scanning', dir);

    var apiSpec = {};

    var metadataFile = path.join(dir, 'metadata.json');
    var attributesFile = path.join(dir, 'attributes', 'default.rb');
    var tempFile = path.join(dir, 'temp.rb');

    var metadata = {};

    // Get recipes and attributes from metadata
    if (fs.existsSync(metadataFile)) {
      metadata = JSON.parse(fs.readFileSync(metadataFile));
      metadata.attributes = metadata.attributes || {};
      metadata.recipes = metadata.recipes || {};

      apiSpec.executable_type = 'chef_cookbook';
    } else {
      //TODO: generate metadata.json from metadata.rb file, if JSON variant doesn't exist using the following command: knife cookbook metadata mysql -o /cookbooks
      return done();
    }

    // Get more recipes from Ruby files
    _.each(fs.readdirSync(path.join(dir, 'recipes')), function(file) {
      if (fs.statSync(path.join(dir, 'recipes', file)).isDirectory()) return;

      var name = metadata.name + '::' + path.basename(file, '.rb');

      if (file === 'default.rb') var name = metadata.name;

      metadata.recipes[name] = metadata.recipes[name] || '';
    });

    // Get more attributes from Ruby files
    var rubyBin = process.env.RUBY_BIN || 'ruby';
    //var defaultPlatform = process.env.DEFAULT_PLATFORM || 'ubuntu';
    //var defaultPlatformVersion = process.env.DEFAULT_PLATFORM_VERSION || '14.04';

    var ruby = exec([ 'echo "require \'json\'\n' +
                      'default = Hash.new(Hash.new)\n' +
                      'default[\'' + metadata.name + '\'] = Hash.new\n' +
                      'node = Hash.new(Hash.new)\n' +
                      //'node[\'platform\'] = \'' + defaultPlatform + '\'\n' +
                      //'node[\'platform_version\'] = \'' + defaultPlatformVersion + '\'\n' +
                      '" >> ' + tempFile,
                      'cat ' + attributesFile + ' >> ' + tempFile,
                      'echo "\nputs default.to_json" >> ' + tempFile,
                      rubyBin + ' ' + tempFile,
                      'rm ' + tempFile ].join(' && '),
      function(err, stdout, stderr) {
        if (err && err.code != 0) {
          console.error('Warning: Cannot read additional cookbook attributes file.');

          debug(err, stderr, stdout);
        } else {
          var attributes = flatten(JSON.parse(stdout.replace(/(\r\n|\n|\r)/gm, '')), { delimiter: '/' });

          _.each(attributes, function(val, key) {
            var type = 'unknown';

            if (_.isNumber(val)) type = 'number';
            else if (_.isBoolean(val)) type = 'boolean';
            else if (_.isString(val)) type = 'string';

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
