Connections = new Mongo.Collection('connections')
People = new Mongo.Collection('people')

if (Meteor.isClient) {
  Session.setDefault('targetScreenName', null)
  Session.setDefault('peopleIds', null)
  Session.set('loading', false)

  connectionsHandler = Meteor.subscribe('connections', Session.get('targetScreenName'))
  // peopleHandler = Meteor.subscribe('people', Session.get('peopleIds'))
  peopleHandler = Meteor.subscribe('people')

  function screenName () {
    if (Meteor.userId()) return Meteor.user().services.twitter.screenName
  }

  Template.form.helpers({
    'disabled': function() { return (Session.get('busy') ? "disabled" : null) }
  })

  Template.form.events({
    'submit form': function (e, t) {
      e.preventDefault()
      if (Session.get('busy')) return false

      var nextTargetScreenName = t.find('input').value
      if (!nextTargetScreenName) return false

      var currentTargetScreenName = Session.get('targetScreenName')
      if (currentTargetScreenName && nextTargetScreenName !== currentTargetScreenName && connectionsHandler) connectionsHandler.stop() 
      Session.set('targetScreenName', nextTargetScreenName)
      Session.set('busy', true)
      Meteor.call('fetchFriends', nextTargetScreenName, function() { Session.set('busy', false) })
    }
  })

  Template.connections.rendered = function () {
    this.autorun(function(tracker) {
      connectionsHandler = Meteor.subscribe('connections', Session.get('targetScreenName'))
      // peopleHandler = Meteor.subscribe('people', Session.get('peopleIds'))
    })
  }
  
  Template.connections.helpers({
    connectionsReady: function() { 
      return connectionsHandler.ready()
    },
    connections: function() {
      if (Meteor.userId() && Meteor.user()) {
        var userFollowers = Connections.findOne({screenName: Meteor.user().profile.screenName})
        var targetFriends = Connections.findOne({screenName: Session.get('targetScreenName')})
        if (userFollowers && targetFriends) {
          var ids = _.intersection(userFollowers.followers, targetFriends.friends)
          // if(ids && ) peopleHandler.stop()
          // Session.set('peopleIds', ids)
          console.log('peopleIds', ids)
          return People.find({id: {$in: ids}},{sort: {followers_count: -1}})
        }
      }
    },
    targetScreenName: function() { return Session.get('targetScreenName') }
  })
}

if (Meteor.isServer) {
  Fiber = Npm.require('fibers')

  T = new TwitMaker({
    consumer_key:         Meteor.settings.CONSUMER_KEY,
    consumer_secret:      Meteor.settings.CONSUMER_SECRET,
    access_token:         Meteor.settings.BOT_ACCESS_TOKEN,
    access_token_secret:  Meteor.settings.BOT_SECRET
  })

  Accounts.onLogin(function(){
    var user = Meteor.users.findOne(this.userId)
    if (user) {
      T.setAuth({
        access_token: user.services.twitter.accessToken,
        access_token_secret: user.services.twitter.accessTokenSecret
      })
      
    }
  })
  Accounts.onCreateUser(function(options, user) {
    if (options.profile) user.profile = options.profile
    user.profile.screenName = user.services.twitter.screenName
    return user
  });

  /*
  path: twitter api path
  options: twitter api options for dealing request limits
  - maxRequestForWindow
  - requestCount
  - windowTime
  */
  function twitterGet(path, options, getOptions, callback) {
    var buffer = []
    var requestCount = 0

    if (!options.maxRequestForWindow) options.maxRequestForWindow = 15
    if (!options.windowTime) options.windowTime = 15 * 60 * 1000

    if (!getOptions.cursor) getOptions.cursor = -1

    function _callback (err, data, resp) {
      if (err) {
        console.log(path + " returned error", err)
      } else {
        console.log(path + " fetched")
        buffer.push(data)
        if (data.next_cursor > 0) {
          getOptions.cursor = data.next_cursor
          recursiveCall()
        } else {
          callback(buffer)
        }
      }
    }

    function recursiveCall () {
      if (++requestCount === options.maxRequestForWindow) {
        requestCount = 0
        Meteor.setTimeout(function () { T.get(path, getOptions, _callback) }, options.windowTime)
      } else {
        T.get(path, getOptions, _callback)
      }
    }

    recursiveCall()
  }

  function userLookup (userIds) {
    var pages = Math.ceil(userIds.length / 100)
    var page = 0
    var buffer = []
    var pageUserIds = []
    function recursiveCall(page) {
      pageUserIds = _.first(_.rest(userIds, page), 100)
      // console.log("pageUserIds", pageUserIds)
      twitterGet('users/lookup', {maxRequestForWindow: 180}, {user_id: pageUserIds}, function(dataArray) {
        buffer.push(dataArray)
        page++
        if( (page) === pages) {
          Fiber(function(){
            _.each(_.flatten(buffer), function(person) {
              People.upsert({id: person.id}, person)
            })
          }).run()
        }else{
          recursiveCall(page)
        }
      })
    }
    recursiveCall(page)
  }

  Meteor.publish('connections', function(targetScreenName) {
    if (this.userId && targetScreenName) {
      var user = Meteor.users.findOne(this.userId)
      // don't fetch user followers if exists
      if (Connections.find({screenName: user.services.twitter.screenName}).count() === 0) {
        twitterGet('followers/ids', {}, {screen_name: user.services.twitter.screenName}, function(dataArray) {
          var userIds = _.flatten(_.pluck(dataArray, 'ids'))

          Fiber(function(){
            Connections.upsert({screenName: user.services.twitter.screenName}, {screenName: user.services.twitter.screenName, followers: userIds})
          }).run()

          userLookup(userIds)
        })
      }
      return Connections.find({screenName: {$in: [user.services.twitter.screenName, targetScreenName]}})
    } else {
      return this.ready()
    }
  })

  // Meteor.publish('people', function(ids) {
  //   if(ids){
  //     return People.find({id: {$in: ids}})
  //   } else {
  //     this.ready()
  //   }
  // })
  Meteor.publish('people', function(ids) { 
    return People.find()
  })

  Meteor.methods({
    fetchFriends: function(targetScreenName) {
      if (!this.userId) {
        throw new Meteor.Error("unauthorized", "You must be signed in")
      }
      check(targetScreenName, String)
      if (Connections.find({screenName: targetScreenName}).count() === 0){
        twitterGet('friends/ids', {}, {screen_name: targetScreenName}, function(dataArray) {
          var userIds = _.flatten(_.pluck(dataArray, 'ids'))

          Fiber(function(){
            Connections.upsert({screenName: targetScreenName}, {screenName: targetScreenName, friends: userIds})
          }).run()

          userLookup(userIds)
        })
      }
    }
  })
}
